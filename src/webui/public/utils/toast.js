// Third arg: number (duration ms) or { duration?, sticky? }. Sticky toasts do not auto-dismiss.
window.showToast = function(message, type, opts) {
  type = type || 'info';
  var sticky = false;
  var duration;
  if (typeof opts === 'number') {
    duration = opts;
  } else if (opts && typeof opts === 'object') {
    sticky = !!opts.sticky;
    duration = opts.duration;
  }
  if (duration == null) {
    if (type === 'error') duration = 10000;
    else if (type === 'warning') duration = 12000;
    else duration = 6000;
  }
  var container = document.getElementById('toast-container');
  if (!container) return;
  var el = document.createElement('div');
  el.className = 'toast toast-' + type + (sticky ? ' toast-sticky' : '');
  el.textContent = message;
  if (sticky) {
    var close = document.createElement('span');
    close.textContent = ' \u00D7';
    close.style.marginLeft = '10px';
    close.style.cursor = 'pointer';
    close.style.fontWeight = 'bold';
    el.appendChild(close);
  }
  el.onclick = function() { dismiss(); };
  container.appendChild(el);
  var timer = sticky ? null : setTimeout(dismiss, duration);
  function dismiss() {
    if (timer) clearTimeout(timer);
    if (!el.parentNode) return;
    el.classList.add('toast-out');
    el.addEventListener('animationend', function() { el.remove(); });
  }
};
