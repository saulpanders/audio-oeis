#!/usr/bin/env python3
"""
Local dev server for OEIS Audio Sequencer.
Serves static files and proxies /api/oeis?id=AXXXXXX to oeis.org.

Usage:
    python proxy.py              # normal SSL verification
    python proxy.py --no-verify  # skip SSL cert checks (useful behind corporate proxies)
"""
import re
import ssl
import sys
import json
import urllib.request
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = 8000
NO_VERIFY = '--no-verify' in sys.argv


def make_ssl_context():
    if NO_VERIFY:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/oeis':
            self._proxy_oeis(parse_qs(parsed.query))
        else:
            super().do_GET()

    def _proxy_oeis(self, params):
        seq_id = params.get('id', [''])[0].strip().upper()
        if not re.match(r'^A\d{1,6}$', seq_id):
            self._json(400, {'error': 'Invalid OEIS ID'})
            return
        url = f'https://oeis.org/search?q=id:{seq_id}&fmt=json'
        req = urllib.request.Request(url, headers={'User-Agent': 'oeis-audio-sequencer/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=10, context=make_ssl_context()) as r:
                body = r.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.URLError as e:
            self._json(502, {'error': str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f'  {args[1]}  {args[0]}')


if __name__ == '__main__':
    import functools
    flag = ' (SSL verification disabled)' if NO_VERIFY else ''
    print(f'Listening on http://localhost:{PORT}{flag}')
    print('Open http://localhost:8080 in your browser')
    HTTPServer(('localhost', PORT), functools.partial(Handler, directory='public')).serve_forever()
