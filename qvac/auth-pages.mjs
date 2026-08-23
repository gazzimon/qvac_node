// Pantalla de login, separada de pages.mjs a proposito: ese archivo tiene
// el NAV/STYLE compartido de los 3 paneles y esta en edicion activa de otra
// persona del equipo en paralelo. Este modulo no importa nada de ahi -- el
// look dark se copia a mano (mismos colores, cero dependencia).

export const LOGIN_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QVAC · login</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
      background: #0f1115; color: #e6e6e6;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .box {
      width: 100%; max-width: 340px; background: #171a21;
      border: 1px solid #262b36; border-radius: 12px; padding: 1.75rem 1.5rem;
    }
    h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
    .sub { color: #8b93a7; font-size: .85rem; margin: 0 0 1.4rem; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-size: .82rem; color: #a9b4cc; margin-bottom: .3rem; }
    input {
      width: 100%; background: #10131a; border: 1px solid #262b36; color: #e6e6e6;
      border-radius: 8px; padding: .6rem; font-family: inherit; font-size: .9rem;
    }
    button {
      width: 100%; background: #4a7dfc; color: #fff; border: none; border-radius: 8px;
      padding: .65rem 1.1rem; font-size: .9rem; cursor: pointer; margin-top: .4rem;
    }
    button:hover { background: #3a6ae8; }
    button:disabled { opacity: .6; cursor: default; }
    .error {
      display: none; background: #3a1414; color: #f87171; border-radius: 8px;
      padding: .55rem .7rem; font-size: .82rem; margin-bottom: 1rem;
    }
    .error.on { display: block; }
  </style>
</head>
<body>
  <div class="box">
    <h1>QVAC · marketplace</h1>
    <p class="sub">Ingresá con tu usuario para entrar al panel que te corresponde.</p>
    <p class="error" id="error">Usuario o contraseña incorrectos.</p>
    <form id="form">
      <div class="field">
        <label for="usuario">Usuario</label>
        <input type="text" id="usuario" name="usuario" autocomplete="username" autofocus>
      </div>
      <div class="field">
        <label for="password">Contraseña</label>
        <input type="password" id="password" name="password" autocomplete="current-password">
      </div>
      <button type="submit" id="submit">Ingresar</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('form')
    const errorEl = document.getElementById('error')
    const submitBtn = document.getElementById('submit')

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      errorEl.classList.remove('on')
      submitBtn.disabled = true
      submitBtn.textContent = 'Ingresando…'
      try {
        const usuario = document.getElementById('usuario').value
        const password = document.getElementById('password').value
        const r = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usuario, password })
        })
        const data = await r.json()
        if (r.ok && data.ok) {
          window.location = data.redirect
          return
        }
        errorEl.classList.add('on')
      } catch {
        errorEl.classList.add('on')
      }
      submitBtn.disabled = false
      submitBtn.textContent = 'Ingresar'
    })
  </script>
</body>
</html>`
