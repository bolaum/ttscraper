import fs from 'fs';
import path from 'path';
// import moment from 'moment';

import config from 'config';
import _ from 'lodash';
import filesizeJs from 'filesize.js';
import cliProgress from 'cli-progress';
import PQueue from 'p-queue';
import { DownloaderHelper } from 'node-downloader-helper';
import axios from 'axios';

import log from './logger';

const PAD_SIZE = 8;

const multiBar = new cliProgress.MultiBar(
  {
    format: '|{bar}| {percentage}% || {speed} || {curSize} / {totalSize} || {fileName} || ETA: {eta_formatted}',
    etaBuffer: 50,
    clearOnComplete: true,
    autopadding: true,
  },
  cliProgress.Presets.shades_classic,
);

function filesize(size, end = false) {
  return _[`pad${end ? 'End' : 'Start'}`](filesizeJs(size), PAD_SIZE);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line
async function downloadFileSim(file) {
  // log.debug('STARTED: %s (%s)', file.fileName, filesize(file.size));
  const parallelDownloads = config.get('downloads.parallelDownloads');

  const fileBar = multiBar.create(file.size, 0, {
    curSize: filesize(0),
    totalSize: filesize(file.size, true),
    fileName: file.fileName,
  });

  const KBPS = 300000.0 / parallelDownloads;
  const updateTime = 50.0;
  const totalTimeMs = (parseFloat(file.size) / (KBPS * 1000.0)) * 1000.0;
  const parts = totalTimeMs / updateTime;

  // if (file.size > 10000000) {
  //   log.debug('parts: %s %s %s', parts, totalTimeMs, filesize(file.size));
  // }

  let bytesDownloaded = 0;
  for (let i = 0; i < parts; i += 1) {
    await sleep(updateTime);

    bytesDownloaded += updateTime * KBPS;
    const curDownloaded = Math.min(bytesDownloaded, file.size);

    fileBar.update(curDownloaded, {
      curSize: filesize(curDownloaded),
    });
  }

  fileBar.update(file.size, {
    curSize: filesize(file.size),
  });

  await sleep(100);

  fileBar.stop();
  multiBar.remove(fileBar);

  // log.debug('STOPPED: %s (%s)', file.fileName, filesize(file.size));
}

async function downloadFile(file) {
  const saveToBase = config.get('downloads.saveTo');
  const fileDir = path.join(saveToBase, file.directory._id);
  const filePath = path.join(fileDir, file.fileName);

  return new Promise(async (resolve) => {
    let fileBar = null;

    let finished = false;

    const finish = async (finalSize) => {
      if (finished || !fileBar) {
        return;
      }

      finished = true;

      fileBar.update(finalSize, {
        totalSize: filesize(finalSize),
        curSize: filesize(finalSize),
      });

      await sleep(100);

      fileBar.stop();
      multiBar.remove(fileBar);
    };

    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }

    let shouldDownload = true;

    try {
      const { headers: fileHead } = await axios.head(file.url);
      const fileSize = parseInt(fileHead['content-length']);

      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size === fileSize) {
          shouldDownload = false;
        }
      }
    } catch (error) {
      shouldDownload = false;
    }

    if (shouldDownload) {
      const dl = new DownloaderHelper(file.url, fileDir, {
        fileName: file.fileName,
        retry: { maxRetries: 3, delay: 1000 },
        override: true,
      });

      dl.on('download', (downloadInfo) => {
        if (finished) return;

        fileBar = multiBar.create(downloadInfo.totalSize, 0, {
          fileName: file.fileName,
          totalSize: filesize(downloadInfo.totalSize, true),
          curSize: filesize(0),
          speed: `${filesize(0)}/s`,
        });
      });

      dl.on('progress', (stats) => {
        if (finished) return;

        fileBar.update(stats.downloaded, {
          curSize: filesize(stats.downloaded),
          speed: `${filesize(stats.speed)}/s`,
        });
      });

      // dl.on('error', (error) => {
      //   // log.error('ERROR: %s\n%o', file.url, error);
      // });

      // dl.once('end', async (downloadInfo) => {
      //   // log.debug('CARAAAAAAAAAAAAAAAAAAAAAIIII %s %o', downloadInfo);
      // });

      // dl.on('retry', (error) => {
      //   // log.error('ERROR: %s\n%o', file.url, error);
      // });

      try {
        await dl.start();
      } catch (error) {
        // log.debug('ERRORRRR: %o', error);
      }

      await finish(file.size);
      resolve();
    } else {
      await finish(file.size);
      resolve();
    }
  });
}

/** @param {import('mongodb').Db} db */
export async function downloadFiles(db) {
  log.info('Downloading files from server...');

  const downloadPath = config.get('downloads.saveTo');
  const parallelDownloads = config.get('downloads.parallelDownloads');

  if (!fs.existsSync(downloadPath)) {
    throw new Error(`Download path does not exist (${downloadPath})`);
  }

  const filesCol = db.collection(config.get('mongo.filesColName'));

  const matchFilter = {
    downloaded: { $ne: true },
    _id: { $regex: /^Books/ },
  };

  const { totalSize, numFiles } = _.first(
    await filesCol
      .aggregate([
        { $match: matchFilter },
        { $group: { _id: null, totalSize: { $sum: '$size' }, numFiles: { $sum: 1 } } },
      ])
      .toArray(),
  );

  log.info('Total files size is %s for %s files', filesize(totalSize), numFiles);

  const filesCursor = filesCol.aggregate([
    {
      $match: matchFilter,
    },
    {
      $lookup: {
        from: config.get('mongo.directoriesColName'),
        localField: 'directoryId',
        foreignField: '_id',
        as: 'directory',
      },
    },
    {
      $unwind: '$directory',
    },
  ]);

  let sizeDone = 0;
  let filesDone = 0;
  const queue = new PQueue({ concurrency: parallelDownloads });
  let handling = false;

  const totalsBar = multiBar.create(totalSize, 0, {
    curSize: _.padStart(filesDone, PAD_SIZE),
    totalSize: _.padEnd(numFiles, PAD_SIZE),
    fileName: 'Total files',
    speed: 'N/A',
  });

  await new Promise(async (resolve) => {
    const handleNextFile = async () => {
      if (!handling) {
        handling = true;
        try {
          if (await filesCursor.hasNext()) {
            const file = await filesCursor.next();

            if (file.size > 0) {
              queue
                .add(() => downloadFile(file))
                .then(() => {
                  filesDone += 1;
                  sizeDone += file.size;
                  totalsBar.update(sizeDone, {
                    curSize: _.padStart(filesDone, PAD_SIZE),
                  });

                  _.defer(() => handleNextFile());
                });
            }
          } else {
            await queue.onIdle();
            resolve();
          }
        } catch (error) {
          // TODO
        }
        handling = false;
      } else {
        _.defer(() => handleNextFile());
      }
    };

    for (let i = 0; i < parallelDownloads * 10; i += 1) {
      await handleNextFile();
    }
  });

  totalsBar.stop();
  multiBar.remove(totalsBar);
  multiBar.stop();
}
