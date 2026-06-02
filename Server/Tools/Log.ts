const types = {
  info: 'Info',
  success: 'Success',
  warn: 'Warn',
  error: 'Error',
  debug: 'Debug'
}

const colors = {
  info: '\x1b[34m', // Blue
  success: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
  debug: '\x1b[35m', // Magenta
  reset: '\x1b[0m' // Reset
}

export default class Log {
  /**
   * Log an info message to the console
   * @param content Content to log
   */
  static info(...content: any[]): void {
    this.log('info', ...content)
  }

  /**
   * Log a success message to the console
   * @param content Content to log
   */
  static success(...content: any[]): void {
    this.log('success', ...content)
  }

  /**
   * Log a warning message to the console
   * @param content Content to log
   */
  static warn(...content: any[]): void {
    this.log('warn', ...content)
  }

  /**
   * Log an error message to the console
   * @param content Content to log
   */
  static error(...content: any[]): void {
    this.log('error', ...content)
  }

  /**
   * Log a debug message to the console
   * @param content Content to log
   */
  static debug(...content: any[]): void {
    this.log('debug', ...content)
  }

  /**
   * Log a message to the console
   * @param type The type of message to log
   * @param content The content to log
   */
  private static log(type: keyof typeof types, ...content: any[]): void {
    const color = colors[type] || colors.reset
    const dateTime = this.datetime()
    const dateTimeStr = dateTime ? ` ${dateTime}` : ''
    const clusterStr = this.getClusterStr()

    if (process.env['NODE_ENV'] === 'development' && process.env['LOG_DEBUG_LOCATION'] === 'true' && type === 'debug') {
      const stack = new Error().stack?.split('\n')[3].trim()
      const location = stack ? stack.substring(stack.indexOf('(') + 1, stack.indexOf(')')) : 'unknown location'
      console.log(`[${color}${types[type]}${colors.reset}]${dateTimeStr}${clusterStr} [${location}]:`, ...content)
    } else {
      console.log(`[${color}${types[type]}${colors.reset}]${dateTimeStr}${clusterStr}:`, ...content)
    }
  }

  /**
   * Get the cluster ID string with proper padding
   * @returns Formatted cluster ID string like " [C01]" or empty string if not in cluster mode
   */
  private static getClusterStr(): string {
    const clusterID = process.env['CLUSTER_ID']
    const clusterCount = process.env['CLUSTER_COUNT']

    if (clusterID === undefined) return ''

    const maxDigits = clusterCount ? String(parseInt(clusterCount) - 1).length : 2
    const paddedID = this.pad(parseInt(clusterID), maxDigits)

    return ` [${paddedID}]`
  }

  /**
   * Get the current datetime
   * @returns Current datetime in the format of YYYY-MM-DD HH:MM:SS
   */
  public static datetime(): string {
    if (process.env['LOG_DATETIME'] === 'false') return ''
    const date = new Date()
    // YYYY-MM-DD HH:MM:SS, with local time
    return `${date.getFullYear()}-${this.pad(date.getMonth() + 1)}-${this.pad(date.getDate())} ${this.pad(date.getHours())}:${this.pad(date.getMinutes())}:${this.pad(date.getSeconds())}`
  }

  /**
   * Pad a number with leading zeros
   * @param num The number to pad
   * @param size The desired length of the output string
   * @returns The padded number as a string
   */
  private static pad(num: number, size: number = 2): string {
    let s = num.toString()
    while (s.length < size) {
      s = '0' + s
    }
    return s
  }
}
