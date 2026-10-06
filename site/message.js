(() => {
  const widget = document.createElement('div');
  widget.innerHTML = `
    <button type="button" class="message-launcher" aria-haspopup="dialog">Send us a message</button>
    <dialog class="message-dialog" aria-labelledby="message-title">
      <button type="button" class="message-close" aria-label="Close message form">×</button>
      <h2 id="message-title">Send us a message</h2>
      <p>Questions, feedback, or ideas — we’d love to hear them.</p>
      <form>
        <label for="message-body">Your message</label>
        <textarea id="message-body" name="message" rows="6" maxlength="5000" required></textarea>
        <label for="message-email">Email <span>(optional, if you’d like a reply)</span></label>
        <input id="message-email" name="email" type="email" maxlength="254" autocomplete="email">
        <p class="message-status" role="status" aria-live="polite"></p>
        <button type="submit" class="message-send">Send message</button>
      </form>
    </dialog>`;
  document.body.append(widget);
  const dialog = widget.querySelector('dialog');
  const launcher = widget.querySelector('.message-launcher');
  const form = widget.querySelector('form');
  const message = widget.querySelector('textarea');
  const email = widget.querySelector('input');
  const status = widget.querySelector('.message-status');
  const send = widget.querySelector('.message-send');
  let pending = false;
  let submission;
  launcher.addEventListener('click', () => { dialog.showModal(); message.focus(); });
  widget.querySelector('.message-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => launcher.focus());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const body = message.value.trim();
    if (!body) { status.textContent = 'Please enter a message.'; message.focus(); return; }
    const payload = { message: body, email: email.value.trim(), page: location.pathname };
    const signature = JSON.stringify(payload);
    // A retry after a lost response must not save the same submission twice.
    if (!submission || submission.signature !== signature) submission = { signature, id: crypto.randomUUID() };
    pending = true;
    send.disabled = message.disabled = email.disabled = true;
    send.textContent = 'Sending…';
    status.textContent = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://khsky10r4l.execute-api.us-east-1.amazonaws.com/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, id: submission.id }), signal: controller.signal
      });
      if (!response.ok) throw new Error('Submission failed');
      form.reset();
      submission = null;
      status.textContent = 'Thanks! Your message has been sent.';
    } catch (_) {
      status.textContent = 'Your message could not be confirmed. Please try again.';
    } finally {
      clearTimeout(timeout);
      pending = false;
      send.disabled = message.disabled = email.disabled = false;
      send.textContent = 'Send message';
    }
  });
})();
