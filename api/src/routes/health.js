module.exports = function createHealthRoute({ pool, verifySmtp }) {
  return async function healthRoute(req, res) {
    const body = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {},
    };

    let critical = false;

    if (process.env.HEALTH_SKIP_DB === '1' || !pool) {
      body.checks.database = { status: 'skipped' };
    } else {
      const start = Date.now();
      try {
        await pool.query('SELECT 1');
        body.checks.database = { status: 'ok', latencyMs: Date.now() - start };
      } catch (e) {
        body.checks.database = { status: 'error', latencyMs: Date.now() - start, error: e.message };
        critical = true;
      }
    }

    if (process.env.HEALTH_SKIP_SMTP === '1' || !verifySmtp) {
      body.checks.smtp = { status: 'skipped' };
    } else {
      const start = Date.now();
      try {
        const result = await Promise.race([
          verifySmtp(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 3000ms')), 3000)),
        ]);
        body.checks.smtp = result.ok
          ? { status: 'ok', latencyMs: Date.now() - start }
          : { status: 'warn', latencyMs: Date.now() - start, error: result.error };
      } catch (e) {
        body.checks.smtp = { status: 'warn', latencyMs: Date.now() - start, error: e.message };
      }
    }

    if (critical) {
      body.status = 'degraded';
      return res.status(503).json(body);
    }
    res.json(body);
  };
};
