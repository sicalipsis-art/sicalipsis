"""Serve a folder over HTTP on localhost with CORS headers, for local previews.
Usage: python serve_cors.py <folder> <port>"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), partial(Handler, directory=sys.argv[1])).serve_forever()
