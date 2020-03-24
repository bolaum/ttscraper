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
import fileSizeParser from 'filesize-parser';

import log from './logger';

const PAD_SIZE = 10;

const multiBar = new cliProgress.MultiBar(
  {
    format: '{bar} {percentage}%  {speed}  {curSize} / {totalSize}  {fileName}  ETA: {eta_formatted}',
    etaBuffer: 50,
    clearOnComplete: true,
    autopadding: true,
  },
  cliProgress.Presets.shades_classic,
);

function filesize(size, end = false, speed = false) {
  return _[`pad${end ? 'End' : 'Start'}`](speed ? `${filesizeJs(size)}/s` : filesizeJs(size), PAD_SIZE);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line
async function downloadFileSim(db, file) {
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

async function downloadFile(db, file) {
  const saveToBase = config.get('downloads.saveTo');
  const fileDir = path.join(saveToBase, file.directory._id);
  const filePath = path.join(fileDir, file.fileName);
  const filesCol = db.collection(config.get('mongo.filesColName'));

  return new Promise(async (resolve) => {
    let fileBar = null;

    let finished = false;

    const finish = (finalSize) => {
      if (finished || !fileBar) {
        return;
      }

      finished = true;

      fileBar.update(finalSize, {
        totalSize: filesize(finalSize),
        curSize: filesize(finalSize),
      });

      fileBar.stop();
      multiBar.remove(fileBar);
      fileBar = null;
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

          await filesCol.updateOne({ _id: file._id }, {
            $set: {
              downloaded: true,
              size: fileSize,
            },
          });
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

      const fileBarUpdateThrottled = _.throttle((stats) => {
        if (fileBar) {
          fileBar.update(stats.downloaded, {
            curSize: filesize(stats.downloaded),
            speed: filesize(stats.speed, false, true),
          });
        }
      }, 150, { leading: false, trailing: true });

      dl.on('download', (downloadInfo) => {
        if (finished) return;

        fileBar = multiBar.create(downloadInfo.totalSize, 0, {
          fileName: file.fileName,
          totalSize: filesize(downloadInfo.totalSize, true),
          curSize: filesize(0),
          speed: filesize(0, false, true),
        });
      });

      dl.on('progress', (stats) => {
        if (finished) return;

        fileBarUpdateThrottled(stats);
      });

      dl.on('timeout', (stats) => {
        if (fileBar) {
          fileBar.update(file.size, {
            fileName: `${file.fileName} (TIMEOUT)`,
          });
        }
      });

      dl.on('error', (error) => {
        if (fileBar) {
          fileBar.update(file.size, {
            fileName: `${file.fileName} (ERROR)`,
          });
        }

        dl.stop();
        finish(file.size);
      });

      dl.once('end', async (downloadInfo) => {
        if (fileBar) {
          fileBar.update(downloadInfo.totalSize, {
            curSize: filesize(downloadInfo.totalSize),
            fileName: `${file.fileName} (ENDED)`,
          });
        }

        await filesCol.updateOne({ _id: file._id }, {
          $set: {
            downloaded: true,
            size: downloadInfo.totalSize,
          },
        });

        finish(file.size);
      });

      dl.on('retry', (error) => {
        if (fileBar) {
          fileBar.update(file.size, {
            fileName: `${file.fileName} (RETRY)`,
          });
        }
      });

      try {
        await dl.start();
      } catch (error) {
        // log.debug('ERRORRRR: %o', error);
      }

      if (fileBar) {
        fileBar.update(file.size, {
          fileName: `${file.fileName} (FINISHED)`,
          totalSize: filesize(file.size, true),
        });
      }

      resolve();
    } else {
      resolve();
    }
  });
}

const FILES_REGEX = /^Books\/Dungeons/;

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
    _id: { $regex: FILES_REGEX },
    downloaded: { $ne: true },
    size: { $lt: fileSizeParser('1 GB') },
  };

  const totals = await filesCol
    .aggregate([
      { $match: matchFilter },
      { $group: { _id: null, totalSize: { $sum: '$size' }, numFiles: { $sum: 1 } } },
    ])
    .toArray();

  if (!totals.length) {
    log.info('No files to download');
    return;
  }

  const { totalSize, numFiles } = _.first(totals);

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
    // curSize: _.padStart(filesDone, PAD_SIZE),
    // totalSize: _.padEnd(numFiles, PAD_SIZE),
    curSize: filesize(0),
    totalSize: filesize(totalSize, true),
    fileName: 'All files',
    speed: _.padStart('N/A', PAD_SIZE),
  });

  let pollInterval = null;

  await new Promise(async (resolve) => {
    const handleNextFile = async () => {
      if (!handling) {
        handling = true;
        try {
          if (await filesCursor.hasNext()) {
            const file = await filesCursor.next();

            if (file.size > 0) {
              queue
                .add(() => downloadFile(db, file))
                .then(() => {
                  filesDone += 1;
                  sizeDone += file.size;
                  totalsBar.update(sizeDone, {
                    fileName: `Total files (${numFiles - filesDone} left)`,
                    curSize: filesize(sizeDone),
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
        setTimeout(() => handleNextFile(), 20);
      }
    };

    for (let i = 0; i < parallelDownloads * 10; i += 1) {
      await handleNextFile();
    }

    pollInterval = setInterval(() => {
      handleNextFile();
    }, 2000);
  });

  clearInterval(pollInterval);

  totalsBar.stop();
  multiBar.remove(totalsBar);
  multiBar.stop();
}
