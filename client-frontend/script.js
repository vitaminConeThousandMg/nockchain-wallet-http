/* Nockchain Wallet – Millennium Edition
 * Front-end script with proper hoisting & ordering
 * Last updated: 2025-07-27
 */

document.addEventListener('DOMContentLoaded', () => {
  /*────────────────────────────────────────────────────────*
   │ 0. HELPERS – define these first so $ / $all exist   
   *────────────────────────────────────────────────────────*/
  function $(sel, root = document)    { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  /*────────────────────────────────────────────────────────*
   │ 1. INITIAL BOOT                                       
   *────────────────────────────────────────────────────────*/
  const desktop   = $('#desktop-area');
  const launcher  = $('#launcher');
  const statusTxt = $('#status-text');
  const clockTxt  = $('#clock');
  const blip      = new Audio('https://freesound.org/data/previews/256/256113_3263906-lq.mp3');

  let zTop        = 20;           // running z-index
  const MAXIMISED = Symbol();     // sentinel for maximise state

  function playBlip() {
    blip.currentTime = 0;
    blip.play().catch(()=>{});
  }

  function setStatus(txt = 'Ready.') {
    statusTxt.textContent = txt;
  }

  function centre(win) {
    // clear any CSS transform (e.g. from centring)
    win.style.transform = 'none';

    const { left: dl, top: dt, width: dw, height: dh } = desktop.getBoundingClientRect();
    const { offsetWidth: ww, offsetHeight: wh }        = win;
    win.style.left = `${dl + (dw - ww) / 2}px`;
    win.style.top  = `${dt + (dh - wh) / 2}px`;
  }

  /*────────────────────────────────────────────────────────*
   │ 2. LAUNCH-PAD BUTTONS                                 
   *────────────────────────────────────────────────────────*/
  $all('.launch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      playBlip();
      const id  = btn.dataset.launch;
      const win = $(`#window-${id}`);
      if (!win) return;
      launcher.classList.add('hidden');
      openWindow(win);
    });
  });

  /*────────────────────────────────────────────────────────*
   │ 3. GENERIC WINDOW HANDLING                            
   *────────────────────────────────────────────────────────*/
  function bringToFront(win) {
    win.style.zIndex = ++zTop;
    $all('.win98-window').forEach(w => w.classList.toggle('active', w === win));
  }

  function openWindow(win) {
    win.style.transform = 'none';           // clear centring transform
    if (win.dataset.state !== 'open') {
      centre(win);
    }
    win.style.display   = 'block';
    win.dataset.state   = 'open';
    bringToFront(win);
    setStatus(`${$('.win98-title', win).textContent} opened.`);
  }

  function closeWindow(win) {
    win.style.display  = 'none';
    win.dataset.state  = 'closed';
    setStatus(`${$('.win98-title', win).textContent} closed.`);
    playBlip();

    // if no task windows remain, show the launcher
    const anyOpen = $all('.win98-window')
      .some(w => w.style.display !== 'none' && w !== launcher);
    if (!anyOpen) launcher.classList.remove('hidden');
  }

  // Attach drag & title-bar controls to every .win98-window
  $all('.win98-window').forEach(win => {
    const tb = win.querySelector('.win98-titlebar.internal');
    if (!tb) return;

    // DRAGGING
    tb.addEventListener('mousedown', startDrag);

    // MIN / MAX / CLOSE
    $all('[data-action]', tb).forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        playBlip();
        const action = btn.dataset.action;
        switch (action) {
          case 'minimize':
            win.style.display = 'none';
            win.dataset.state = 'minimised';
            setStatus(`${$('.win98-title', win).textContent} minimised.`);
            break;
          case 'maximize':
            toggleMaximise(win);
            break;
          case 'close':
            closeWindow(win);
            break;
        }
      });
    });

    // FOCUS on click
    win.addEventListener('mousedown', () => bringToFront(win));
  });

  // DRAG HELPERS
  function startDrag(e) {
    const win = e.currentTarget.parentElement;
    if (win[MAXIMISED]) return;  // don't drag if maximised
    bringToFront(win);

    const { left, top } = win.getBoundingClientRect();
    const offsetX = e.clientX - left;
    const offsetY = e.clientY - top;

    function onMove(ev) {
      win.style.left = `${ev.clientX - offsetX}px`;
      win.style.top  = `${ev.clientY - offsetY}px`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // MAXIMISE / RESTORE
  function toggleMaximise(win) {
    const desk = desktop.getBoundingClientRect();
    if (!win[MAXIMISED]) {
      // save old bounds
      win[MAXIMISED] = {
        left:   win.style.left,
        top:    win.style.top,
        width:  win.style.width,
        height: win.style.height,
      };
      Object.assign(win.style, {
        left:   `${desk.left}px`,
        top:    `${desk.top}px`,
        width:  `${desk.width}px`,
        height: `${desk.height}px`,
      });
      setStatus('Window maximised.');
    } else {
      Object.assign(win.style, win[MAXIMISED]);
      delete win[MAXIMISED];
      setStatus('Window restored.');
    }
  }

  /*────────────────────────────────────────────────────────*
   │ 4. DEMO CONTROLS (fake delays, forms, etc.)          
   *────────────────────────────────────────────────────────*/
  function fakeLoad(btn, working = 'Working…', done = 'Done!') {
    const orig = btn.textContent;
    btn.textContent    = working;
    btn.disabled       = true;
    setStatus(working);
    document.body.classList.add('loading');

    setTimeout(() => {
      btn.textContent    = orig;
      btn.disabled       = false;
      setStatus(done);
      document.body.classList.remove('loading');
      playBlip();
    }, 1000 + Math.random() * 2000);
  }

  $('#refresh-balance')?.addEventListener('click', e => fakeLoad(e.target, 'Refreshing…'));
  $('#refresh-utxos')?.addEventListener('click', e => fakeLoad(e.target, 'Refreshing…'));

  $('#add-recipient')?.addEventListener('click', () => {
    const list = $('#recipients-list');
    if (list.rows.length >= 99) {
      alert('Maximum recipients reached (99).');
      return;
    }
    const row = list.rows[0].cloneNode(true);
    $all('input', row).forEach(i => i.value = '');
    list.appendChild(row);
    playBlip();
  });

  $('#send-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.target);
    fakeLoad(btn, 'Sending…', 'Nock sent!');
    setTimeout(() => {
      alert('Nock sent successfully!');
      e.target.reset();
    }, 1800);
  });

  /*────────────────────────────────────────────────────────*
   │ 5. RETRO CRT FLICKER & LIVE CLOCK                    
   *────────────────────────────────────────────────────────*/
  setInterval(() => {
    document.body.style.filter = 'brightness(110%) contrast(90%)';
    setTimeout(() => (document.body.style.filter = ''), 150);
  }, 30000 + Math.random() * 30000);

  function tickClock() {
    const now = new Date();
    clockTxt.textContent = now.toLocaleTimeString([], {
      hour:   '2-digit',
      minute: '2-digit'
    });
  }
  tickClock();
  setInterval(tickClock, 1000);

  /*────────────────────────────────────────────────────────*
   │ 6. FINAL BOOTSTRAP                                   
   *────────────────────────────────────────────────────────*/
  centre(launcher);
  bringToFront(launcher);
  setStatus('Ready.');
});

