module.exports = function createHealthRoute(pool) {
  return async function healthRoute(req, res) {
    const body = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };

    if (process.env.HEALTH_SKIP_DB === '1' || !pool) {
      return res.json(body);
    }

    try {
      await pool.query('SELECT 1');
      body.database = 'ok';
    } catch (e) {
      body.status = 'degraded';
      body.database = 'error';
      body.databaseError = e.message;
      return res.status(503).json(body);
    }

    res.json(body);
  };
};
