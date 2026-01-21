import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import { getWebuiLogs, clearWebuiLogs } from '../utils/logCapture';

export function createControlRoutes(botManager: BotManager): Router {
  const router = Router();

  // Auth is applied in server.ts via requireAuth middleware

  /**
   * GET /api/bot/status
   * Get bot status
   */
  router.get('/status', (req: Request, res: Response) => {
    try {
      const status = botManager.getStatus();
      res.json({
        success: true,
        status
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/bot/start
   * Start the bot
   */
  router.post('/start', async (req: Request, res: Response) => {
    try {
      const result = await botManager.start();
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/bot/restart
   * Restart the bot
   */
  router.post('/restart', async (req: Request, res: Response) => {
    try {
      const result = await botManager.restart();
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/bot/shutdown
   * Shutdown the bot
   */
  router.post('/shutdown', async (req: Request, res: Response) => {
    try {
      const emergency = req.body.emergency === true;

      if (emergency) {
        // Restart container - gracefully exit and let Docker restart policy handle it
        console.log('[Control] Container restart requested');

        res.json({
          success: true,
          message: 'Container restarting...'
        });

        // Shutdown bot and exit cleanly - Docker will restart us
        setTimeout(async () => {
          console.log('[Control] Shutting down for container restart...');
          if (botManager.isRunning()) {
            try {
              await botManager.shutdown(false);
            } catch (err) {
              console.error('[Control] Error during bot shutdown:', err);
            }
          }
          console.log('[Control] Exiting process - Docker will restart container');
          process.exit(0);
        }, 500);

        return;
      } else {
        // Normal shutdown - just stop bot process
        await botManager.shutdown(false);
        res.json({
          success: true,
          message: 'Bot shutdown initiated'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/bot/restart-server
   * Restart the entire server (web-ui + bot)
   * Used when OAuth/session settings change and require web server restart
   */
  router.post('/restart-server', async (req: Request, res: Response) => {
    try {
      console.log('[Control] Full server restart requested');

      res.json({
        success: true,
        message: 'Server restart initiated'
      });

      // Give time for response to be sent
      setTimeout(async () => {
        // Stop bot first
        if (botManager.getStatus().running) {
          try {
            await botManager.shutdown(false);
          } catch (err) {
            console.error('[Control] Error during bot shutdown:', err);
          }
        }
        console.log('[Control] Exiting process for full restart');
        process.exit(0);
      }, 500);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * GET /api/logs
   * Get current logs
   */
  router.get('/logs', (req: Request, res: Response) => {
    try {
      const includeCrash = req.query.includeCrash === 'true';
      const rawLimit = req.query.limit as string;

      // Validate and bound the limit parameter
      let limit = 100; // default
      if (rawLimit) {
        const parsedLimit = parseInt(rawLimit, 10);
        if (isNaN(parsedLimit) || parsedLimit < 0) {
          res.status(400).json({
            success: false,
            error: 'Invalid limit parameter - must be a positive integer'
          });
          return;
        }
        // Enforce bounds: min 1, max 1000
        limit = Math.min(Math.max(parsedLimit, 1), 1000);
      }

      const logs = botManager.getLogs(includeCrash);

      // Limit the number of logs returned
      const limitedLogs = {
        ...logs,
        current: logs.current.slice(-limit)
      };

      res.json({
        success: true,
        logs: limitedLogs
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * GET /api/logs/webui
   * Get Web-UI logs
   */
  router.get('/logs/webui', (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
      const logs = getWebuiLogs(limit);

      res.json({
        success: true,
        logs,
        source: 'webui'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/logs/clear
   * Clear all logs (bot + webui)
   */
  router.post('/logs/clear', (req: Request, res: Response) => {
    try {
      botManager.clearLogs();
      clearWebuiLogs();
      res.json({
        success: true,
        message: 'All logs cleared'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  return router;
}
