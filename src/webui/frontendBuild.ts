// src/webui/frontendBuild.ts

import express, { Express, NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { isAdminPagePath } from './middleware/pathGuard';

// The package root's webui-built folder, the same from src/webui, dist/webui and /app/dist/webui.
export const BUILT_DIR = path.resolve(__dirname, '..', '..', 'webui-built');

/** The files scripts/buildFrontend.cjs writes. */
export const BUILT_FILES = ['assets/vendor.js', 'assets/guild.js', 'admin.js'];

export const MISSING_BUILD_MESSAGE =
  'The web panel\'s scripts are not built. Run "npm run build:webui" in the bot\'s folder and reload this page. In Docker, rebuild the image.';

export function missingBuiltFiles(builtDir: string): string[] {
  return BUILT_FILES.filter(file => !fs.existsSync(path.join(builtDir, file)));
}

const NOT_A_PAGE = /^\/(?:auth|assets)(?:\/|$)/;

/** Before the page routes: a page request answers 503 with the build command while a built file is absent. */
export function requireFrontendBuild(builtDir: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (req.method !== 'GET' || !isAdminPagePath(req.path) || NOT_A_PAGE.test(req.path) || missingBuiltFiles(builtDir).length === 0) {
      next();
      return;
    }
    res.status(503).type('text/plain').send(MISSING_BUILD_MESSAGE);
  };
}

export const MISSING_BUILD_LOG =
  '[WebUI] The web panel\'s scripts are not built: page requests answer 503 until "npm run build:webui" has run (in Docker, rebuild the image).';

/** The built scripts as static files, then the missing-build answer for page requests. */
export function mountFrontendBuild(app: Express, builtDir: string): void {
  app.use(express.static(builtDir, {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  }));
  app.use(requireFrontendBuild(builtDir));
}
