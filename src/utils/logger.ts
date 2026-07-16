import pino from 'pino';

import { env } from './config.js';

const options: pino.LoggerOptions = { level: env.LOG_LEVEL };

if (env.NODE_ENV === 'development') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(options);
