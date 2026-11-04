(() => {
  const bookingUrl = 'https://calendar.google.com/calendar/appointments/schedules/AcZssZ2oQH0337bmx-uPEz6Ojqsza_Opmz9jgcY_qb3F3JpC5SjTGsqLIic-nlVkb2nK--XXSi31SyAU?gv=true';
  const widget = document.createElement('div');
  widget.innerHTML = `
    <div class="contact-actions">
      <button type="button" class="message-launcher" aria-haspopup="dialog">Send us a message</button>
      <a class="call-launcher" href="${bookingUrl}" target="_blank" rel="noopener" aria-haspopup="dialog">Book a call</a>
    </div>
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
    </dialog>
    <dialog class="booking-dialog" aria-labelledby="booking-title">
      <div class="booking-header">
        <h2 id="booking-title">Book a call</h2>
        <button type="button" class="booking-close" aria-label="Close booking calendar" autofocus>×</button>
      </div>
      <div class="booking-content">
        <p class="booking-loading" role="status">Loading available times…</p>
        <iframe class="booking-frame" title="Book a 30-minute call with Yoav"></iframe>
      </div>
      <div class="booking-footer">
        <span>Powered by Google Calendar</span>
        <a href="${bookingUrl}" target="_blank" rel="noopener">Open in a new tab ↗</a>
      </div>
    </dialog>`;
  document.body.append(widget);
  const dialog = widget.querySelector('.message-dialog');
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
  const booking = widget.querySelector('.booking-dialog');
  const book = widget.querySelector('.call-launcher');
  const frame = widget.querySelector('.booking-frame');
  const loading = widget.querySelector('.booking-loading');
  book.addEventListener('click', event => {
    // Preserve opening the direct link in a new tab with a modifier key.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || typeof booking.showModal !== 'function') return;
    event.preventDefault();
    booking.showModal();
    // Load only on first open, and preserve the visitor's selection on reopen.
    if (!frame.getAttribute('src')) frame.src = bookingUrl;
  });
  frame.addEventListener('load', () => {
    if (frame.getAttribute('src')) loading.hidden = true;
  });
  widget.querySelector('.booking-close').addEventListener('click', () => booking.close());
  booking.addEventListener('close', () => book.focus());
  booking.addEventListener('click', event => {
    if (event.target !== booking) return;
    const rect = booking.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) booking.close();
  });
})();
