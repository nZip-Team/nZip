import os from 'os'

/** Lock identity of this process; passed to the core as NZIP_PROCESS_ID */
export const processID = `${os.hostname()}-${process.pid}-${Date.now()}`
