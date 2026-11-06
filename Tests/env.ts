// Imported first by every test: Config reads these when it loads
process.env['API_URL'] ||= 'https://api.example.test'
process.env['IMAGE_URL'] ||= 'https://images.example.test'
process.env['LOG_DATETIME'] = 'false'
