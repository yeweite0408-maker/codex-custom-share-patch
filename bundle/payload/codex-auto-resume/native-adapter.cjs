/* Native Codex adapter; generation goes through its normal startTurn path. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CodexAutoResumeAdapter = api;
})(globalThis, function() {
  'use strict';
  const adapters = new WeakMap();
  const PROMPT = '额度已恢复，请从上次停止处继续完成本任务。先核对已有结果与当前进度，避免重复执行已完成的操作；保持原任务范围、模型和权限要求。如有需要用户决定或审批的事项，请正常等待。';
  function create(manager, helpers) {
    if (adapters.has(manager)) return adapters.get(manager);
    const normalize = helpers.normalizeThread, latest = helpers.latest, lastServer = helpers.lastServer;
    const leases = new Map();
    const requestsBlocked = conversation => (conversation.requests || []).some(request => request.completed !== true) ||
      (conversation.unconfirmedTurnSubmissions || []).some(submission => submission.terminal !== true);
    const queued = thread => (manager.turnCoordinator?.readMessages(thread) || []).length > 0;
    const archived = thread => !!manager.isConversationSuppressedAfterArchive(thread);
    const inspect = thread => {
      const id = normalize(thread), conversation = manager.getConversation(id);
      if (manager.disposed || !conversation) return {loaded: false};
      const turn = latest(conversation);
      return {loaded: true, archived: archived(id), turnId: turn?.turnId ?? null,
        status: turn?.status, error: turn?.error,
        blocked: requestsBlocked(conversation) || queued(id) ||
          conversation.threadRuntimeStatus?.type === 'active' || manager.getStreamRole(id)?.role === 'follower'};
    };
    const resume = async (thread, failedTurnId) => {
      const id = normalize(thread), clientId = helpers.createId ? helpers.createId() : crypto.randomUUID();
      const guard = (requireOwner = true) => {
        if (manager.disposed || !helpers.canResume(thread, failedTurnId)) throw new Error('Auto-resume was cancelled');
        const conversation = manager.getConversation(id);
        if (!conversation || archived(id)) throw new Error('Auto-resume task is unavailable');
        const server = lastServer(conversation), current = latest(conversation);
        if (!server || server.turnId !== failedTurnId || server.status !== 'failed' || !helpers.isUsageLimitError(server.error))
          throw new Error('The failed task has changed');
        const ownPending = current?.turnId == null && current?.params?.clientUserMessageId === clientId;
        if (current?.turnId !== failedTurnId && !ownPending) throw new Error('Another turn is present');
        if (requestsBlocked(conversation) || queued(id) || (!ownPending && conversation.threadRuntimeStatus?.type === 'active'))
          throw new Error('The task is busy or waiting for approval');
        const role = manager.getStreamRole(id)?.role;
        if (role === 'follower' || (requireOwner && role !== 'owner')) throw new Error('Another window owns this task');
      };
      guard(false);
      const cwd = manager.getConversationCwd(id);
      if (typeof cwd !== 'string' || !cwd) throw new Error('Task workspace is unavailable');
      const result = await manager.resumeConversation({conversationId: id, model: null, reasoningEffort: null,
        workspaceRoots: [cwd], collaborationMode: manager.getConversation(id)?.latestCollaborationMode ?? null,
        preserveServerConfiguration: true});
      if (result?.status !== 'ready') throw new Error('Task could not be resumed');
      guard();
      await manager.startTurn(id, {
        request: {threadId: id, clientUserMessageId: clientId, input: [{type: 'text', text: PROMPT, text_elements: []}]},
        context: {inheritThreadSettings: true, assertRequestCurrent: () => guard(),
          restoreMessage: {id: clientId, text: PROMPT, cwd, createdAt: Date.now(),
            context: {prompt: PROMPT, addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null, workspaceRoots: [cwd]}}},
      });
      return {status: 'accepted'};
    };
    const watch = (thread, enabled) => {
      const id = normalize(thread);
      if (!enabled || manager.disposed) {
        const lease = leases.get(id); leases.delete(id);
        try { lease?.[Symbol.dispose]?.(); } catch {}
      } else if (!leases.has(id)) {
        leases.set(id, manager.retainActiveConversation(id));
      }
    };
    const adapter = Object.freeze({inspect, resume, watch,
      readLimits: () => manager.requestClient.sendRequest('account/rateLimits/read', {})});
    adapters.set(manager, adapter); return adapter;
  }
  return Object.freeze({create, PROMPT});
});
