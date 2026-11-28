import type { Router } from 'express';
import { getRequestContext, logInternalError } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** Notifications and alerting: channels, rules, alert events, SMTP diagnostics and the Mailpit inbox. */
export function registerAlertRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { alertEngine, resolveActor, requireScope, probeRateLimit } = ctx;

  apiRouter.get('/alerts', requireScope('read'), (_req, res) => {
    res.json(alertEngine.getPublicState());
  });

  apiRouter.put('/alerts/channels', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const updated = await alertEngine.updateChannels({
        smtp: req.body?.smtp,
        webhook: req.body?.webhook,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update notification channels',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/alerts/rules', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const saved = await alertEngine.upsertRule(req.body ?? {});
      res.status(req.body?.id ? 200 : 201).json(saved);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to save alert rule',
        tier,
        requestId,
      });
    }
  });

  apiRouter.delete('/alerts/rules/:id', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const removed = await alertEngine.deleteRule(req.params.id);
    if (!removed.deleted) {
      res.status(404).json({ error: 'Alert rule not found', tier, requestId });
      return;
    }
    res.json(removed);
  });

  apiRouter.post('/alerts/test-channel', probeRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const channel = req.body?.channel === 'webhook' ? 'webhook' : 'email';
    try {
      const outcome = await alertEngine.testChannel(channel, {
        recipient: typeof req.body?.recipient === 'string' ? req.body.recipient : undefined,
        webhookUrl: typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl : undefined,
      });
      res.status(outcome.status === 'sent' ? 200 : 502).json({ outcome });
    } catch (err) {
      logInternalError(err, 'Alert channel test failed', requestId);
      res.status(500).json({
        error: 'Alert channel test failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/alerts/events/:id/ack', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor } = resolveActor(req);
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const event = await alertEngine.acknowledgeEvent(req.params.id, actor, note);
    if (!event) {
      res.status(404).json({ error: 'Alert event not found', tier, requestId });
      return;
    }
    res.json({ event, state: alertEngine.getPublicState() });
  });

  apiRouter.post('/alerts/events/:id/unack', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor } = resolveActor(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const event = await alertEngine.reopenEvent(req.params.id, actor, reason);
    if (!event) {
      res.status(404).json({ error: 'Alert event not found', tier, requestId });
      return;
    }
    res.json({ event, state: alertEngine.getPublicState() });
  });

  apiRouter.patch('/alerts/events/:id/note', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor } = resolveActor(req);
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    const event = await alertEngine.updateEventNote(req.params.id, actor, note);
    if (!event) {
      res.status(404).json({ error: 'Alert event not found', tier, requestId });
      return;
    }
    res.json({ event, state: alertEngine.getPublicState() });
  });

  // SMTP Diagnostics & Mailpit REST API Proxy
  apiRouter.post('/alerts/smtp/verify', probeRateLimit, requireScope('admin'), async (_req, res) => {
    const result = await alertEngine.verifySmtpConnection();
    res.status(result.reachable ? 200 : 502).json(result);
  });

  apiRouter.post('/alerts/smtp/send-test', probeRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const result = await alertEngine.sendDiagnosticEmail({
        recipient: typeof req.body?.recipient === 'string' ? req.body.recipient : undefined,
        subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      });
      res.status(result.outcome.status === 'sent' ? 200 : 502).json(result);
    } catch (err) {
      logInternalError(err, 'SMTP diagnostic send failed', requestId);
      res.status(500).json({
        error: 'SMTP diagnostic send failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.get('/alerts/mailpit/status', requireScope('read'), async (req, res) => {
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.fetchMailpitStatus(apiBaseUrl);
    res.status(result.connected ? 200 : 502).json(result);
  });

  apiRouter.get('/alerts/mailpit/messages', requireScope('read'), async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.fetchMailpitMessages({ limit, query, apiBaseUrl });
    res.status(result.reachable ? 200 : 502).json(result);
  });

  apiRouter.get('/alerts/mailpit/messages/:id', requireScope('read'), async (req, res) => {
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.fetchMailpitMessageDetail(req.params.id, apiBaseUrl);
    res.status(result.reachable ? 200 : 502).json(result);
  });

  apiRouter.delete('/alerts/mailpit/messages', requireScope('admin'), async (req, res) => {
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.clearMailpitInbox(apiBaseUrl);
    res.status(result.cleared ? 200 : 502).json(result);
  });
}
