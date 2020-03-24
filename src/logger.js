import config from 'config';

import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: config.get('logging.level'),
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.splat(),
    format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
  ),
  transports: [new transports.Console()],
});

export default logger;
