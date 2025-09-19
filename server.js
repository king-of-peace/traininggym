/**
 * Monolithic Portfolio — single file server (frontend + backend)
 *
 * Usage:
 * 1. copy .env.example -> .env and edit ADMIN_PASSWORD and SESSION_SECRET
 * 2. npm install
 * 3. node server.js   (or npm run dev with nodemon)
 * 4. open http://localhost:4000
 *
 * Features:
 * - Home page (projects + posts)
 * - Contact form (stores into SQLite messages table)
 * - Admin login (session-based)
 * - Admin dashboard: view messages, create/edit/delete posts
 *
 * Important: change ADMIN_PASSWORD and SESSION_SECRET before using on public server.
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 4000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));

// Simple in-memory projects (you can edit these)
const projects = [
  { id: 1, title: 'Portfolio Website', description: 'Responsive portfolio with contact form and blog', tech: ['HTML', 'CSS', 'Node'] },
  { id: 2, title: 'API Backend', description: 'Express + SQLite backend for small apps', tech: ['Node', 'Express', 'SQLite'] }
];

// DB setup (sqlite file in same folder)
const DB_FILE = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('DB open error', err);
  else console.log('SQLite DB opened at', DB_FILE);
});

// Create tables if not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    excerpt TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
});

// -------------- Middleware --------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// -------------- Routes: public pages --------------

app.get('/', async (req, res) => {
  // get posts from db
  db.all('SELECT id, slug, title, excerpt, created_at FROM posts ORDER BY created_at DESC', (err, posts) => {
    if (err) posts = [];
    const html = renderPage('Home', renderHome(projects, posts, req.session));
    res.send(html);
  });
});

app.get('/post/:slug', (req, res) => {
  const slug = req.params.slug;
  db.get('SELECT * FROM posts WHERE slug = ?', [slug], (err, row) => {
    if (err || !row) return res.status(404).send(renderPage('Not found', `<h2>Post not found</h2><p><a href="/">Back</a></p>`));
    const html = renderPage(row.title, `<article class="prose max-w-none"><h1>${escapeHtml(row.title)}</h1><p class="text-gray-600">${escapeHtml(row.excerpt||'')}</p><div>${markdownToHtml(escapeHtml(row.content || ''))}</div><p><a href="/">Back</a></p></article>`);
    res.send(html);
  });
});

// Contact form API
app.post('/api/contact', (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'name, email and message required' });
  const stmt = db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)');
  stmt.run(name, email, message, function(err) {
    if (err) return res.status(500).json({ error: 'db error' });
    res.json({ success: true, id: this.lastID });
  });
  stmt.finalize();
});

// serve small static assets (logo, favicon if needed) — optional in same folder
app.get('/favicon.ico', (req, res) => res.status(204).end());

// -------------- Admin pages --------------

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.send(renderPage('Admin Login', renderAdminLogin(req.query.error)));
});

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  // Very simple auth: compare to env values (change ADMIN_PASSWORD before production)
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.adminEmail = email;
    return res.redirect('/admin');
  }
  return res.redirect('/admin/login?error=invalid');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(()=>res.redirect('/'));
});

app.get('/admin', requireAdmin, (req, res) => {
  db.all('SELECT id, name, email, message, created_at FROM messages ORDER BY created_at DESC', (err, messages) => {
    if (err) messages = [];
    db.all('SELECT id, slug, title, excerpt, created_at FROM posts ORDER BY created_at DESC', (err2, posts) => {
      if (err2) posts = [];
      res.send(renderPage('Admin Dashboard', renderAdminDashboard(messages, posts)));
    });
  });
});

// Admin: create post
app.post('/admin/posts', requireAdmin, (req, res) => {
  const { slug, title, excerpt, content } = req.body;
  if (!slug || !title || !content) return res.redirect('/admin?msg=missing');
  const stmt = db.prepare('INSERT OR REPLACE INTO posts (slug, title, excerpt, content) VALUES (?, ?, ?, ?)');
  stmt.run(slug, title, excerpt, content, function(err) {
    if (err) {
      console.error(err);
      return res.redirect('/admin?msg=error');
    }
    return res.redirect('/admin?msg=ok');
  });
});

// Admin: delete post
app.post('/admin/posts/delete', requireAdmin, (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.redirect('/admin?msg=missing');
  db.run('DELETE FROM posts WHERE slug = ?', [slug], function(err) {
    return res.redirect('/admin?msg=deleted');
  });
});

// Admin: delete message
app.post('/admin/messages/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  if (!id) return res.redirect('/admin?msg=missing');
  db.run('DELETE FROM messages WHERE id = ?', [id], function(err) {
    return res.redirect('/admin?msg=deleted');
  });
});

// -------------- Helpers / Templates --------------

function renderPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} — Yusuf</title>
  <style>
    /* Minimal Tailwind-like utility classes (small subset) */
    :root { --max:1100px; --muted:#6b7280; --accent:#0f172a; }
    *{box-sizing:border-box}
    body{font-family:Inter, Arial, sans-serif; margin:0; color:#111; background:#f8fafc}
    .container{max-width:var(--max); margin:0 auto; padding:1rem}
    header{background:var(--accent); color:white}
    header .bar{display:flex; align-items:center; justify-content:space-between; gap:1rem}
    header a{color:#cbd5e1; text-decoration:none; margin-left:1rem}
    .hero{padding:2rem 0}
    .grid{display:grid; gap:1rem; grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
    .card{background:white; padding:1rem; border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .footer{background:#fff; padding:1rem 0; margin-top:2rem; border-top:1px solid #e6e9ef; color:var(--muted)}
    form input, form textarea {width:100%; padding:.6rem; border-radius:6px; border:1px solid #ddd; margin-top:.25rem}
    .btn {background:var(--accent); color:white; padding:.5rem .8rem; border-radius:6px; border:none; cursor:pointer}
    .muted{color:var(--muted)}
    .prose img{max-width:100%}
    .admin-panel{display:flex; gap:1rem; flex-wrap:wrap}
    .small{font-size:.9rem; color:var(--muted)}
  </style>
</head>
<body>
  <header>
    <div class="container bar">
      <div><strong>Yusuf — Programmer</strong></div>
      <nav>
        <a href="/">Home</a>
        <a href="/#projects">Projects</a>
        <a href="/#blog">Blog</a>
        <a href="/admin/login">Admin</a>
      </nav>
    </div>
  </header>

  <main class="container">
    ${bodyHtml}
  </main>

  <footer class="footer">
    <div class="container small">© ${new Date().getFullYear()} Yusuf Abdulsalam — Built with Node.js</div>
  </footer>

  <script>
    // Client-side helper: contact form submit
    async function submitContact(e){
      e.preventDefault();
      const f = e.target;
      const data = { name: f.name.value.trim(), email: f.email.value.trim(), message: f.message.value.trim() };
      if(!data.name || !data.email || !data.message){ alert('Please fill all fields'); return; }
      try {
        const res = await fetch('/api/contact', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
        const j = await res.json();
        if(j && j.success){ alert('Message sent — thank you'); f.reset(); }
        else alert('Error sending message');
      } catch(err) { alert('Network error'); }
    }
  </script>
</body>
</html>`;
}

// Home page body generator
function renderHome(projects, posts, session) {
  return `
  <section class="hero">
    <h1 style="font-size:2rem; margin-bottom:.25rem">Hello — I'm Yusuf</h1>
    <p class="muted">Freelance programmer building web apps and APIs. I specialize in modern web development.</p>
  </section>

  <section id="projects" style="margin-top:2rem">
    <h2>Selected Projects</h2>
    <div class="grid" style="margin-top:.75rem">
      ${projects.map(p => `<div class="card"><h3>${escapeHtml(p.title)}</h3><p class="muted">${escapeHtml(p.description)}</p><small class="small">Tech: ${escapeHtml(p.tech.join(', '))}</small></div>`).join('')}
    </div>
  </section>

  <section id="blog" style="margin-top:2rem">
    <h2>Blog</h2>
    <div style="margin-top:.75rem">
      ${posts.length ? posts.map(post => `<div class="card" style="margin-bottom:.6rem"><h3><a href="/post/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h3><p class="muted">${escapeHtml(post.excerpt||'')}</p></div>`).join('') : '<p class="muted">No posts yet.</p>'}
    </div>
  </section>

  <section id="contact" style="margin-top:2rem">
    <h2>Contact</h2>
    <form onsubmit="submitContact(event)" style="max-width:700px; margin-top:.5rem">
      <label>Name <input name="name" required /></label><br/>
      <label>Email <input name="email" type="email" required /></label><br/>
      <label>Message <textarea name="message" rows="6" required></textarea></label><br/>
      <button class="btn" type="submit">Send message</button>
    </form>
  </section>

  ${session && session.isAdmin ? `<p style="margin-top:1rem"><a href="/admin">Go to admin</a></p>` : ''}
  `;
}

// Admin login HTML
function renderAdminLogin(error) {
  return `
    <h2>Admin Login</h2>
    ${error ? '<p class="muted" style="color:#a00">Invalid credentials</p>' : ''}
    <form method="POST" action="/admin/login" style="max-width:400px">
      <label>Email <input name="email" type="email" required value="${escapeHtml(ADMIN_EMAIL)}" /></label><br/>
      <label>Password <input name="password" type="password" required /></label><br/>
      <button class="btn" type="submit">Login</button>
    </form>
  `;
}

// Admin dashboard HTML
function renderAdminDashboard(messages, posts) {
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem">
      <h2>Admin Dashboard</h2>
      <div><a href="/admin/logout">Logout</a></div>
    </div>

    <section style="margin-top:1rem">
      <h3>Messages</h3>
      ${messages.length ? messages.map(m => `
        <div class="card" style="margin-top:.5rem">
          <div class="small">${escapeHtml(m.email)} — ${escapeHtml(m.created_at)}</div>
          <div style="margin-top:.5rem">${escapeHtml(m.message)}</div>
          <form method="POST" action="/admin/messages/delete" style="margin-top:.5rem">
            <input type="hidden" name="id" value="${m.id}" />
            <button class="btn" type="submit">Delete message</button>
          </form>
        </div>`).join('') : '<p class="muted">No messages yet.</p>'}
    </section>

    <section style="margin-top:1.5rem">
      <h3>Manage Posts</h3>
      <div class="card" style="margin-top:.5rem">
        <form method="POST" action="/admin/posts" style="display:grid; gap:.5rem">
          <label>Slug (unique) <input name="slug" placeholder="my-first-post" required /></label>
          <label>Title <input name="title" required /></label>
          <label>Excerpt <input name="excerpt" /></label>
          <label>Content (plain text or markdown) <textarea name="content" rows="6" required></textarea></label>
          <div style="display:flex; gap:.5rem">
            <button class="btn" type="submit">Create / Update</button>
          </div>
        </form>
      </div>

      <div style="margin-top:.75rem">
        <h4>Existing posts</h4>
        ${posts.length ? `<ul>${posts.map(p => `<li style="margin-bottom:.5rem"><strong>${escapeHtml(p.title)}</strong> — <span class="small">${escapeHtml(p.slug)}</span>
          <form method="POST" action="/admin/posts/delete" style="display:inline-block; margin-left:.5rem">
            <input type="hidden" name="slug" value="${escapeHtml(p.slug)}" />
            <button class="btn" type="submit">Delete</button>
          </form>
        </li>`).join('')}</ul>` : '<p class="muted">No posts.</p>'}
      </div>
    </section>
  `;
}

// Simple HTML escape
function escapeHtml(s) {
  if (!s && s !== 0) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Very small markdown-to-html fallback for basic formatting (converts linebreaks & paragraphs)
function markdownToHtml(md) {
  // keep it tiny: convert headings and line breaks
  if (!md) return '';
  let out = md
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    .replace(/\[(.*?)\]\((.*?)\)/gim, '<a href="$2" target="_blank">$1</a>');
  // paragraphs
  out = out.split(/\\n\\n+/).map(p => `<p>${p.replace(/\\n/g, '<br/>')}</p>`).join('');
  return out;
}

// -------------- Start server --------------
app.listen(PORT, () => {
  console.log(`Monolithic portfolio running at http://localhost:${PORT}`);
  console.log('Admin login -> /admin/login');
});
