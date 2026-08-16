const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 7000);

/** URL pública usada para montar URLs absolutas do proxy dentro dos streams. */
function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, '');
  return `http://localhost:${PORT}`;
}

module.exports = { HOST, PORT, publicBaseUrl };