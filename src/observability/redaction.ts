const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'email',
  'ssn',
  'api_key',
  'apikey',
  'client_secret',
])

export function redact(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map(redact)
  }

  const redactedObj: any = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        redactedObj[key] = '[REDACTED]'
      } else {
        redactedObj[key] = redact(obj[key])
      }
    }
  }
  return redactedObj
}
