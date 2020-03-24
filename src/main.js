import fs from 'fs';

import { MongoClient } from 'mongodb';

import { getTree, genDirectoriesUrls, fetchDirFiles } from './utils';
import { downloadFiles } from './download';
import log from './logger';

/** @param {import('mongodb').Db} db */
async function run(db) {
  const tree = await getTree();
  await genDirectoriesUrls(db, tree);
  await fetchDirFiles(db);
  await downloadFiles(db);
}

async function main() {
  log.info('ttscraper started');

  const mongoClient = await MongoClient.connect(process.env.MONGO_URL, { useUnifiedTopology: true });
  const db = mongoClient.db('ttscraper');

  if (!fs.existsSync('./cache')) {
    fs.mkdirSync('./cache', { recursive: true });
  }

  try {
    await run(db);
  } catch (error) {
    log.error(`${error}\n${error.stack}`);
    process.exit(1);
  }

  await mongoClient.close();

  log.info('Bye!');
}

main();
