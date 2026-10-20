import { parentPort, workerData } from 'node:worker_threads';
import { runBackupWorker } from './backup.js';

try {
  const value = await runBackupWorker(workerData.operation, workerData.options);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'BACKUP_FAILED';
  // Error messages from filesystem/SQLite may contain paths or data. The parent
  // receives a bounded public error category only.
  parentPort.postMessage({ ok: false, code, message: `Backup operation failed (${code})` });
}
