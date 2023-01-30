import { parentPort, workerData } from 'worker_threads';
import { StrUtil, FileUtil, DateUtil } from './utils';
import { GzhInfo, ArticleInfo, DownloadOption, Service, NodeWorkerResponse, NwrEnum, DlEventEnum } from './service';
import axios from 'axios';
import md5 from 'blueimp-md5';
import * as fs from 'fs';
import * as path from 'path';
import * as mysql from 'mysql';
import * as Readability from '@mozilla/readability';

const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const service = new Service();
// html转markdown的TurndownService
const turndownService = service.createTurndownService();
// 下载数量限制
// 获取文章列表时，数量查过此限制不再继续获取列表，而是采集详情页后再继续获取列表
const DOWNLOAD_LIMIT = 10;
// 获取文章列表的url
const LIST_URL = 'https://mp.weixin.qq.com/mp/profile_ext?action=getmsg&f=json&count=10&is_ok=1';
// 插入数据库的sql
const TABLE_NAME = workerData.tableName;
const INSERT_SQL = `INSERT INTO ${TABLE_NAME} ( title, content, author, content_url, create_time, copyright_stat) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title = ? , create_time=?`;
const SELECT_SQL = `SELECT title, content, author, content_url, create_time FROM ${TABLE_NAME} WHERE create_time >= ? AND create_time <= ?`;

// 数据库连接配置
const connectionConfig: mysql.ConnectionConfig = workerData.connectionConfig;
// 设置中心的配置
const downloadOption: DownloadOption = workerData.downloadOption;
// 下载事件（单个下载还是批量）
const dlEvent: DlEventEnum = workerData.dlEvent;
// 存储公众号信息的对象
let GZH_INFO: GzhInfo;
// 数据库连接
let CONNECTION: mysql.Connection;

const port = parentPort;
if (!port) throw new Error('IllegalState');

// 接收消息，执行任务
port.on('message', async () => {
  // 初始化数据库连接
  await createMysqlConnection();

  // 下载单个文章
  if (dlEvent == DlEventEnum.ONE) {
    const url = workerData.data;
    const articleInfo = new ArticleInfo(null, null, url);
    await axiosDlOne(articleInfo);
    resp(NwrEnum.ONE_FINISH, '');
  } else if (dlEvent == DlEventEnum.BATCH_WEB) {
    // 从微信接口批量下载
    GZH_INFO = workerData.data;
    await batchDownloadFromWeb();
  } else if (dlEvent == DlEventEnum.BATCH_DB) {
    // 从数据库批量下载
    await batchDownloadFromDb();
  }
  // 关闭数据库连接
  if (CONNECTION) {
    CONNECTION.end();
  }
  // 通知主线程关闭此线程
  resp(NwrEnum.CLOSE, '');
});

port.on('close', () => {
  console.log('on 线程关闭');
});

port.addListener('close', () => {
  console.log('addListener 线程关闭');
});

async function axiosDlOne(articleInfo: ArticleInfo) {
  const response = await axios.get(articleInfo.contentUrl);
  if (response.status != 200) {
    resp(NwrEnum.FAIL, `下载失败，状态码：${response.status}, URL:${articleInfo.contentUrl}`);
    return;
  }
  articleInfo.html = response.data;
  await dlOne(articleInfo);
}

/*
 * 下载单个页面
 */
async function dlOne(articleInfo: ArticleInfo, saveToDb = true) {
  // 预处理微信公号文章html
  if (!articleInfo.html) return;
  const url = articleInfo.contentUrl;
  const htmlStr = service.prepHtml(articleInfo.html);
  // 提取正文
  const doc = new JSDOM(htmlStr);
  const reader = new Readability.Readability(<Document>doc.window.document, { keepClasses: true });
  const article = reader.parse();
  if (!article) {
    resp(NwrEnum.FAIL, '提取正文失败');
    return;
  }
  if (!articleInfo.title) articleInfo.title = article.title;
  if (!articleInfo.author) articleInfo.author = article.byline;

  // 创建保存文件夹和缓存文件夹
  const timeStr = articleInfo.datetime ? DateUtil.format(articleInfo.datetime, 'yyyy-MM-dd') + '-' : '';
  const saveDirName = StrUtil.strToDirName(article.title);
  const savePath = path.join(downloadOption.savePath || '', timeStr + saveDirName);
  if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath, { recursive: true });
  } else {
    // 跳过已有文章
    if (downloadOption.skinExist && downloadOption.skinExist == 1) {
      resp(NwrEnum.SUCCESS, `【${saveDirName}】已存在，跳过此文章`);
      return;
    }
  }
  const tmpPath = path.join(downloadOption.tmpPath || '', md5(url));
  if (!fs.existsSync(tmpPath)) {
    fs.mkdirSync(tmpPath, { recursive: true });
  }

  // 判断是否需要下载图片
  let content;
  let imgCount = 0;
  if (1 == downloadOption.dlImg) {
    await downloadImgToHtml(article.content, savePath, tmpPath).then((obj) => {
      content = obj.html;
      imgCount = obj.imgCount;
    });
  } else {
    content = article.content;
  }
  const $ = cheerio.load(content);
  const readabilityPage = $('#readability-page-1');
  // 插入原文链接
  readabilityPage.prepend(`<div>原文地址：<a href='${url}' target='_blank'>${article.title}</a></div>`);
  // 插入标题
  readabilityPage.prepend(`<h1>${article.title}</h1>`);

  // 判断是否保存到数据库
  if (1 == downloadOption.dlMysql && CONNECTION.state == 'authenticated' && saveToDb) {
    const modSqlParams = [articleInfo.title, articleInfo.html, articleInfo.author, articleInfo.contentUrl, articleInfo.datetime, articleInfo.copyrightStat, articleInfo.title, articleInfo.datetime];
    CONNECTION.query(INSERT_SQL, modSqlParams, function (err, _result) {
      if (err) {
        console.log('mysql插入失败', err.message);
      } else {
        console.log('mysql更新成功');
      }
    });
  }
  // 判断是否保存markdown
  if (1 == downloadOption.dlMarkdown) {
    const markdownStr = turndownService.turndown($.html());
    fs.writeFileSync(path.join(savePath, 'index.md'), markdownStr);
    resp(NwrEnum.SUCCESS, `【${article.title}】保存Markdown完成`);
  }
  // 判断是否保存html
  if (1 == downloadOption.dlHtml) {
    // 添加样式美化
    $('head').append(service.getArticleCss());
    fs.writeFileSync(path.join(savePath, 'index.html'), $.html());
    resp(NwrEnum.SUCCESS, `【${article.title}】保存HTML完成`);
  }
  resp(NwrEnum.SUCCESS, `【${article.title}】下载完成，共${imgCount}张图，url：${url}`);
}

/*
 * 下载图片并替换src
 * html： 正文的html
 * articleUrl： 原文url
 * savePath: 保存文章的路径(已区分文章),例如: D://savePath//测试文章1
 * tmpPath： 缓存路径(已区分文章)，例如：D://tmpPathPath//6588aec6b658b2c941f6d51d0b1691b9
 */
async function downloadImgToHtml(html: string, savePath: string, tmpPath: string): Promise<{ html: string; imgCount: number }> {
  const $ = cheerio.load(html);
  const imgArr = $('img');
  const awaitArr: Promise<void>[] = [];
  let imgCount = 0;
  // 创建保存图片的文件夹
  const imgPath = path.join(savePath, 'img');
  if (imgArr.length > 0 && !fs.existsSync(imgPath)) {
    fs.mkdirSync(imgPath, { recursive: true });
  }

  imgArr.each(function (_i, elem) {
    const $ele = $(elem);
    // 文件后缀
    const fileSuf = $ele.attr('data-type') || 'jpg';
    // 文件url
    const fileUrl = $ele.attr('data-src');
    if (fileUrl) {
      imgCount++;
      const fileName = `${md5(fileUrl)}.${fileSuf}`;
      const dlPromise = FileUtil.downloadFile(fileUrl, tmpPath, fileName).then((_fileName) => {
        $ele.attr('src', path.join('img', fileName));
        // 图片下载完成之，将图片从缓存文件夹复制到需要保存的文件夹
        const resolveSavePath = path.join(imgPath, _fileName);
        if (!fs.existsSync(resolveSavePath)) {
          // 复制
          fs.copyFile(path.join(tmpPath, _fileName), resolveSavePath, (err) => {
            if (err) {
              console.log(err);
              console.log(`复制图片失败，名字：${_fileName}`);
              console.log('tmpPath', path.resolve(tmpPath, _fileName));
              console.log('resolveSavePath', resolveSavePath);
            }
          });
        }
      });
      awaitArr.push(dlPromise);
    }
  });
  for (const dlPromise of awaitArr) {
    await dlPromise;
  }
  return { html: $.html(), imgCount: imgCount };
}

/*
 * 批量下载（来源是数据库）
 */
async function batchDownloadFromDb() {
  const exeStartTime = performance.now();
  if (CONNECTION.state != 'authenticated') {
    resp(NwrEnum.BATCH_FINISH, '数据库初始化失败');
    return;
  }

  const { startDate, endDate } = service.getTimeScpoe(downloadOption);
  const modSqlParams = [startDate, endDate];
  CONNECTION.query(SELECT_SQL, modSqlParams, async function (err, result) {
    if (err) {
      console.log('获取数据库数据失败', err.message);
      resp(NwrEnum.BATCH_FINISH, '获取数据库数据失败');
    } else {
      let articleCount = 0;
      const promiseArr: Promise<void>[] = [];
      for (const dbObj of result) {
        articleCount++;
        const articleInfo: ArticleInfo = service.dbObjToArticle(dbObj);
        promiseArr.push(dlOne(articleInfo, false));
        // 栅栏，防止一次性下载太多
        if (promiseArr.length > DOWNLOAD_LIMIT) {
          for (let i = 0; i < DOWNLOAD_LIMIT; i++) {
            const p = promiseArr.shift();
            await p;
          }
        }
      }
      // 栅栏，等待所有文章下载完成
      for (const articlePromise of promiseArr) {
        await articlePromise;
      }

      const exeEndTime = performance.now();
      const exeTime = (exeEndTime - exeStartTime) / 1000;
      resp(NwrEnum.BATCH_FINISH, `批量下载完成，共${articleCount}篇文章，耗时${exeTime.toFixed(2)}秒`);
    }
  });
}

/*
 * 批量下载(来源是网络)
 */
async function batchDownloadFromWeb() {
  const { startDate, endDate } = service.getTimeScpoe(downloadOption);
  const articleArr: ArticleInfo[] = [];
  const exeStartTime = performance.now();
  // 获取文章列表
  const articleCount: number[] = [0];
  await downList(0, articleArr, startDate, endDate, articleCount);

  // downList中没下载完的，在这处理
  const promiseArr: Promise<void>[] = [];
  for (const article of articleArr) {
    promiseArr.push(axiosDlOne(article));
  }
  // 栅栏，等待所有文章下载完成
  for (const articlePromise of promiseArr) {
    await articlePromise;
  }

  const exeEndTime = performance.now();
  const exeTime = (exeEndTime - exeStartTime) / 1000;

  resp(NwrEnum.BATCH_FINISH, `批量下载完成，共${articleCount[0]}篇文章，耗时${exeTime.toFixed(2)}秒`);
}

/*
 * 获取文章列表
 * nextOffset: 微信获取文章列表所需参数
 * articleArr：文章信息
 * startDate：过滤开始时间
 * endDate：过滤结束时间
 * articleCount：文章数量
 */
async function downList(nextOffset: number, articleArr: ArticleInfo[], startDate: Date, endDate: Date, articleCount: number[]) {
  const response = await axios.get(LIST_URL, {
    params: {
      __biz: GZH_INFO.biz,
      key: GZH_INFO.key,
      uin: GZH_INFO.uin,
      offset: nextOffset
    }
  });
  if (response.status != 200) {
    resp(NwrEnum.FAIL, `获取文章列表失败，状态码：${response.status}`);
    return;
  }
  const oldArticleLengh = articleArr.length;
  const dataObj = response.data;
  const errmsg = dataObj['errmsg'];
  if ('ok' != errmsg) {
    console.log('下载列表url', `${LIST_URL}&__biz=${GZH_INFO.biz}&key=${GZH_INFO.key}&uin=${GZH_INFO.uin}&offset=${nextOffset}`);
    resp(NwrEnum.FAIL, `获取文章列表失败，错误信息：${errmsg}`);
    return;
  }
  const generalMsgList = JSON.parse(dataObj['general_msg_list']);

  for (const generalMsg of generalMsgList['list']) {
    const commMsgInfo = generalMsg['comm_msg_info'];
    const appMsgExtInfo = generalMsg['app_msg_ext_info'];

    const dateTime = new Date(commMsgInfo['datetime'] * 1000);
    // 判断，如果小于开始时间，直接退出
    if (dateTime < startDate) {
      articleCount[0] = articleCount[0] + articleArr.length - oldArticleLengh;
      return;
    }
    // 如果大于结束时间，则不放入
    if (dateTime > endDate) continue;

    service.objToArticle(appMsgExtInfo, dateTime, articleArr);

    if (appMsgExtInfo['is_multi'] == 1) {
      for (const multiAppMsgItem of appMsgExtInfo['multi_app_msg_item_list']) {
        service.objToArticle(multiAppMsgItem, dateTime, articleArr);
      }
    }
  }
  articleCount[0] = articleCount[0] + articleArr.length - oldArticleLengh;
  resp(NwrEnum.SUCCESS, `正在获取文章列表，目前数量：${articleCount[0]}`);
  // 文章数量超过限制，则开始下载详情页
  while (articleArr.length >= DOWNLOAD_LIMIT) {
    const promiseArr: Promise<void>[] = [];
    for (let i = 0; i < DOWNLOAD_LIMIT; i++) {
      const article = articleArr.shift();
      if (article) {
        promiseArr.push(axiosDlOne(article));
      }
    }
    // 栅栏，等待所有文章下载完成
    for (const articlePromise of promiseArr) {
      await articlePromise;
    }
  }

  if (dataObj['can_msg_continue'] == 1) {
    await downList(dataObj['next_offset'], articleArr, startDate, endDate, articleCount);
  }
}

function resp(code: NwrEnum, message: string, data?) {
  if (port) port.postMessage(new NodeWorkerResponse(code, message, data));
}

/*
 * 创建mysql数据库连接
 */
async function createMysqlConnection(): Promise<mysql.Connection> {
  if (1 != downloadOption.dlMysql && 'db' != downloadOption.dlSource) return CONNECTION;
  if (CONNECTION) {
    CONNECTION.end();
  }

  CONNECTION = mysql.createConnection(connectionConfig);
  // 这里是想阻塞等待连接成功
  return new Promise((resolve, _reject) => {
    CONNECTION.connect(() => {
      const sql = 'show tables';
      CONNECTION.query(sql, (err) => {
        if (err) {
          resp(NwrEnum.FAIL, 'mysql连接失败');
          console.log('mysql连接失败', err);
        } else {
          resp(NwrEnum.SUCCESS, 'mysql连接成功');
          console.log('连接成功');
        }
        resolve(CONNECTION);
      });
    });
  });
}