import fs from 'fs';
import path from 'path';
import url from 'url';

import _ from 'lodash';
import config from 'config';
import axios from 'axios';
import moment from 'moment';
import scrapeIt from 'scrape-it';
import fileSizeParser from 'filesize-parser';
import cliProgress from 'cli-progress';

import log from './logger';

const ROOT_URL = config.get('endpoint.rootUrl');

const TIMESTAMP_FILE_EP = url.resolve(ROOT_URL, config.get('endpoint.timestampFile'));
const TREE_FILE_EP = url.resolve(ROOT_URL, config.get('endpoint.treeFile'));

async function checkTimestamp() {
  let localTs = 0;

  const tsFileName = path.basename(config.get('endpoint.timestampFile'));
  const tsFilePath = path.join('./cache', tsFileName);
  const treeFileName = path.basename(config.get('endpoint.treeFile'));
  const treeFilePath = path.join('./cache', treeFileName);

  try {
    const localTsData = fs.readFileSync(tsFilePath);
    localTs = parseInt(localTsData);
  } catch (error) {
    // file not found, no problem!
  }

  const { data: tsData } = await axios.get(TIMESTAMP_FILE_EP);
  const remoteTs = parseInt(tsData);

  if (remoteTs === localTs && fs.existsSync(treeFilePath)) {
    return false;
  }

  fs.writeFileSync(tsFilePath, remoteTs.toString());
  return true;
}

async function scrapeFilesData(remoteUrl) {
  // log.verbose('Scrapping %s ...', remoteUrl);

  const { data } = await scrapeIt(remoteUrl, {
    files: {
      listItem: '.litem.file',
      data: {
        fileName: {
          selector: '.litem_name',
        },
        url: {
          selector: '.litem_name > a',
          attr: 'href',
          convert: (val) => url.resolve(remoteUrl, val),
        },
        lastModified: {
          selector: '.litem_modified',
          convert: (val) => moment(val).toDate(),
        },
        size: {
          selector: '.litem_size',
          convert: (val) => fileSizeParser(val),
        },
      },
    },
  });

  // if (data.files.length) {
  //   log.verbose('%s files found.', data.files.length);
  // } else {
  //   log.verbose('No files found. Skipping...');
  // }

  return data.files;
}

function genDirectoriesUrlsRec(curTree, curPath) {
  const links = [];

  const { type, name, contents } = curTree;

  if (type === 'directory') {
    const finalPath = path.join(curPath, name);
    links.push({
      path: finalPath,
      url: encodeURI(`${ROOT_URL}/${finalPath}/index.html`),
    });

    for (const content of contents) {
      links.push(...genDirectoriesUrlsRec(content, path.join(curPath, name)));
    }
  } else {
    log.warn('Unknown tree type: %s', type);
  }

  return _.flatten(links);
}

export async function getTree() {
  const shouldFetch = await checkTimestamp();

  const treeFileName = path.basename(config.get('endpoint.treeFile'));
  const treeFilePath = path.join('./cache', treeFileName);

  let tree = null;

  if (shouldFetch) {
    log.info('Fetching tree from server...');

    ({ data: tree } = await axios.get(TREE_FILE_EP));
    fs.writeFileSync(treeFilePath, JSON.stringify(tree, null, 2));
  } else {
    log.info('Loading tree from local cache...');

    const treeData = fs.readFileSync(treeFilePath);
    tree = JSON.parse(treeData);
  }

  return tree;
}

/** @param {import('mongodb').Db} db */
export async function genDirectoriesUrls(db, tree) {
  log.info('Generating directories urls...');

  const root = _.first(tree);
  root.name = '';

  const urls = genDirectoriesUrlsRec(root, '');

  const directoriesCol = db.collection(config.get('mongo.directoriesColName'));

  for (const lUrl of urls) {
    if (!(await directoriesCol.findOne({ _id: lUrl.path }))) {
      const doc = {
        _id: lUrl.path,
        url: lUrl.url,
        scraped: false,
      };
      await directoriesCol.insertOne(doc);
    }
  }
}

/** @param {import('mongodb').Db} db */
export async function fetchDirFiles(db) {
  const parallelDirFetches = config.get('downloads.parallelDirFetches');
  const directoriesCol = db.collection(config.get('mongo.directoriesColName'));
  const filesCol = db.collection(config.get('mongo.filesColName'));

  const dataCursor = directoriesCol.find({ scraped: false });
  const dirs = await dataCursor.toArray();

  if (!dirs.length) {
    log.info('No directories files to fetch');
    return;
  }

  log.info('Fetching directories files from server...');
  const bar1 = new cliProgress.SingleBar({
    format: '|{bar}| {percentage}% || {value}/{total} Directories',
  }, cliProgress.Presets.shades_classic);

  bar1.start(dirs.length, 0);

  let toGo = dirs.length;
  let i = 0;

  while (toGo > 0) {
    const curDirs = _.slice(dirs, i, i + parallelDirFetches);

    await Promise.all(
      _.map(curDirs, async (dir) => {
        const scrapedData = await scrapeFilesData(dir.url);
        if (scrapedData.length) {
          for (const file of scrapedData) {
            const id = path.join(dir._id, file.fileName);
            const doc = _.merge(
              {
                _id: id,
                directoryId: dir._id,
              },
              file,
            );
            try {
              // log.debug('Inserting file: %s', doc._id);
              await filesCol.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
            } catch (error) {
              bar1.stop();
              log.error('Error inserting file:\n%o', doc);
              throw error;
            }
          }
        }
        await directoriesCol.updateOne({ _id: dir._id }, { $set: { scraped: true } });
      }),
    );

    toGo -= curDirs.length;
    i += curDirs.length;

    bar1.update(i);
  }

  bar1.stop();
}
