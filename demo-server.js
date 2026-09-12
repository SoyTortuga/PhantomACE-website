const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url.endsWith('/')) url += 'index.html';
  if (url === '/') url = '/index.html';
  if (!path.extname(url)) url += '.html';

  const filePath = path.normalize(path.join(ROOT, url));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const tryFile = (fp, cb) => {
    fs.readFile(fp, (err, data) => {
      if (err) return cb(err);
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'X-Frame-Options': 'SAMEORIGIN',
      });
      res.end(data);
    });
  };

  tryFile(filePath, () => {
    const dirIndex = path.join(filePath.replace(/\.html$/, ''), 'index.html');
    tryFile(dirIndex, () => {
      res.writeHead(404);
      res.end('Not Found');
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n  PhantomACE Demo Server running at:\n`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
