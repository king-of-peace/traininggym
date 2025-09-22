/*
Programmer Portfolio / mini CMS — Single-file React app
Filename: App.jsx

What this includes (all in one file for easy preview & iteration):
- Tailwind-based layout (assumes Tailwind is configured)
- Header, About, Projects (CRUD saved to localStorage), Blog (write posts in Markdown preview), Contact form (opens mailto), Resume download (generates simple PDF), Dark mode, Search & filters
- Uses framer-motion for subtle UI animation and lucide-react icons
- Uses localStorage as the "backend" so you can run this without a server. Easy to extend to a real backend later.

Dependencies to install:
  npm install react react-dom framer-motion lucide-react jspdf react-markdown remark-gfm

Tailwind setup (if you don't have it):
  npx create-react-app my-portfolio
  cd my-portfolio
  npm install -D tailwindcss postcss autoprefixer
  npx tailwindcss init -p
  // configure tailwind.config.js and add tailwind directives to index.css per Tailwind docs

How to use:
  1. Place this file as src/App.jsx (replace existing App.jsx).
  2. Ensure your index.js imports "./index.css" with Tailwind directives.
  3. Install dependencies above.
  4. npm start

NOTE: This file is intentionally self-contained for quick testing. For production, split into components and add a real backend, form handling, and authentication as needed.
*/

import React, { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sun, Moon, PlusCircle, Search, Edit2, Trash2, Download } from 'lucide-react'
import { jsPDF } from 'jspdf'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function App() {
  // theme
  const [dark, setDark] = useState(() => {
    try { return JSON.parse(localStorage.getItem('theme')) ?? false } catch { return false }
  })
  useEffect(() => { localStorage.setItem('theme', JSON.stringify(dark)) }, [dark])

  // Projects stored in localStorage
  const [projects, setProjects] = useState(() => {
    try { return JSON.parse(localStorage.getItem('projects')) ?? sampleProjects() } catch { return sampleProjects() }
  })
  useEffect(() => { localStorage.setItem('projects', JSON.stringify(projects)) }, [projects])

  // Blog posts
  const [posts, setPosts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('posts')) ?? samplePosts() } catch { return samplePosts() }
  })
  useEffect(() => { localStorage.setItem('posts', JSON.stringify(posts)) }, [posts])

  const [query, setQuery] = useState('')
  const [filterLang, setFilterLang] = useState('All')

  // UI state: modal forms
  const [showProjectModal, setShowProjectModal] = useState(false)
  const [editingProject, setEditingProject] = useState(null)
  const [showPostModal, setShowPostModal] = useState(false)
  const [editingPost, setEditingPost] = useState(null)

  // Derived
  const languages = useMemo(() => ['All', ...Array.from(new Set(projects.map(p=>p.lang)) )], [projects])
  const filtered = useMemo(() => projects.filter(p => (filterLang==='All' || p.lang===filterLang) && (p.title.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase()))), [projects, query, filterLang])

  // Project CRUD
  function upsertProject(proj) {
    setProjects(prev => {
      if (!proj.id) {
        proj.id = Date.now().toString()
        return [proj, ...prev]
      }
      return prev.map(p => p.id===proj.id ? proj : p)
    })
    setShowProjectModal(false)
    setEditingProject(null)
  }
  function removeProject(id) { setProjects(prev => prev.filter(p=>p.id!==id)) }

  // Post CRUD
  function upsertPost(post) {
    setPosts(prev => {
      if (!post.id) { post.id = Date.now().toString(); return [post, ...prev] }
      return prev.map(p => p.id===post.id ? post : p)
    })
    setShowPostModal(false); setEditingPost(null)
  }
  function removePost(id) { setPosts(prev => prev.filter(p=>p.id!==id)) }

  // Resume download
  function downloadResume() {
    const doc = new jsPDF()
    doc.setFontSize(18)
    doc.text('Your Name — Programmer', 20, 20)
    doc.setFontSize(12)
    doc.text('Software developer experienced with JavaScript, React, and building web apps.', 20, 30)
    doc.text('Email: you@example.com', 20, 40)
    doc.save('resume.pdf')
  }

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
        <div className="max-w-5xl mx-auto p-6">
          <Header dark={dark} setDark={setDark} />

          <main className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6">
            <section className="md:col-span-2 space-y-6">
              <About />

              <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex-1 flex items-center gap-2 bg-gray-100 dark:bg-gray-700 p-2 rounded-xl">
                    <Search size={16} />
                    <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects or descriptions..." className="bg-transparent outline-none flex-1 text-sm" />
                  </div>
                  <select value={filterLang} onChange={e=>setFilterLang(e.target.value)} className="bg-gray-100 dark:bg-gray-700 p-2 rounded-xl text-sm">
                    {languages.map(l=> <option key={l} value={l}>{l}</option>)}
                  </select>
                  <button onClick={()=>{ setEditingProject(null); setShowProjectModal(true) }} className="p-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 text-white flex items-center gap-2"><PlusCircle size={16}/>New</button>
                </div>

                <AnimatePresence>
                  {filtered.length===0 ? (
                    <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">No projects — add your first project.</motion.div>
                  ) : (
                    <motion.ul layout className="space-y-4">
                      {filtered.map(p=> (
                        <motion.li layout key={p.id} className="bg-gray-50 dark:bg-gray-900 p-4 rounded-xl flex items-start justify-between">
                          <div>
                            <div className="text-sm font-semibold">{p.title} <span className="text-xs ml-2 text-gray-400">{p.lang}</span></div>
                            <div className="text-sm text-gray-500 dark:text-gray-300 mt-1">{p.description}</div>
                            <div className="mt-2 flex gap-2 text-xs">
                              <a href={p.live || '#'} target="_blank" rel="noreferrer" className="underline">Live</a>
                              <a href={p.repo || '#'} target="_blank" rel="noreferrer" className="underline">Repo</a>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2">
                            <button onClick={()=>{ setEditingProject(p); setShowProjectModal(true) }} className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"><Edit2 size={16} /></button>
                            <button onClick={()=>removeProject(p.id)} className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"><Trash2 size={16} /></button>
                          </div>
                        </motion.li>
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>

              </div>

              <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm mt-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="font-semibold">Blog</div>
                  <div className="flex items-center gap-2">
                    <button onClick={()=>{ setEditingPost(null); setShowPostModal(true) }} className="p-2 rounded-xl bg-gray-100 dark:bg-gray-700">New Post</button>
                  </div>
                </div>
                <div className="space-y-4">
                  {posts.map(post=> (
                    <article key={post.id} className="p-3 bg-gray-50 dark:bg-gray-900 rounded-xl">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-semibold">{post.title}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">{new Date(post.createdAt).toLocaleString()}</div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={()=>{ setEditingPost(post); setShowPostModal(true) }} className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"><Edit2 size={16} /></button>
                          <button onClick={()=>removePost(post.id)} className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"><Trash2 size={16} /></button>
                        </div>
                      </div>
                      <div className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{post.content.slice(0,300) + (post.content.length>300? '...':'')}</ReactMarkdown>
                      </div>
                    </article>
                  ))}
                </div>
              </div>

            </section>

            <aside className="space-y-6">
              <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">Quick actions</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Resume, contact, theme</div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button onClick={downloadResume} className="flex items-center gap-2 p-2 rounded-xl bg-gray-100 dark:bg-gray-700"><Download size={16}/>Resume</button>
                    <a href="mailto:you@example.com" className="p-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 text-white text-center">Contact</a>
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm">
                <div className="font-semibold">About</div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Experienced JavaScript developer. Available for freelance and full-time roles. This demo stores projects and posts in the browser — connect to a real API to persist centrally.</p>
              </div>

            </aside>
          </main>

          <footer className="mt-8 text-center text-xs text-gray-500">Made with ❤️ — modify this file to suit your needs.</footer>
        </div>

        {/* Modals */}
        <ProjectModal show={showProjectModal} onClose={()=>{ setShowProjectModal(false); setEditingProject(null)}} onSave={upsertProject} project={editingProject} />
        <PostModal show={showPostModal} onClose={()=>{ setShowPostModal(false); setEditingPost(null)}} onSave={upsertPost} post={editingPost} />

      </div>
    </div>
  )
}

function Header({dark, setDark}) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <div className="text-xl font-bold">Your Name</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">Full-stack / Frontend developer</div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={()=>setDark(d=>!d)} className="p-2 rounded-xl bg-gray-100 dark:bg-gray-700">{dark ? <Sun size={16}/> : <Moon size={16}/>}</button>
      </div>
    </header>
  )
}

function About(){
  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm">
      <div className="flex items-start gap-4">
        <div className="w-20 h-20 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-white text-2xl font-bold">YN</div>
        <div>
          <h2 className="text-lg font-semibold">Hi — I'm Your Name</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">I build delightful web apps and help teams ship faster. I love JavaScript, React and clean interfaces. Replace this text with your bio.</p>
          <div className="mt-3 flex gap-2">
            <a href="#" className="text-sm underline">GitHub</a>
            <a href="#" className="text-sm underline">LinkedIn</a>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectModal({show, onClose, onSave, project}){
  const [form, setForm] = useState(() => project ? {...project} : {title:'', description:'', lang:'JavaScript', repo:'', live:''})
  useEffect(()=>{ setForm(project ? {...project} : {title:'', description:'', lang:'JavaScript', repo:'', live:''}) }, [project, show])
  if(!show) return null
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <motion.div initial={{scale:0.9, opacity:0}} animate={{scale:1, opacity:1}} exit={{scale:0.9, opacity:0}} className="w-full max-w-xl bg-white dark:bg-gray-800 p-6 rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="font-semibold">{project ? 'Edit project' : 'New project'}</div>
          <button onClick={onClose} className="text-sm text-gray-500">Close</button>
        </div>
        <div className="space-y-3">
          <input value={form.title} onChange={e=>setForm({...form, title:e.target.value})} placeholder="Title" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700" />
          <textarea value={form.description} onChange={e=>setForm({...form, description:e.target.value})} placeholder="Short description" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700" rows={3} />
          <input value={form.lang} onChange={e=>setForm({...form, lang:e.target.value})} placeholder="Language / Stack" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700" />
          <input value={form.repo} onChange={e=>setForm({...form, repo:e.target.value})} placeholder="Repo URL" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700" />
          <input value={form.live} onChange={e=>setForm({...form, live:e.target.value})} placeholder="Live demo URL" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700" />

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="p-2 rounded-xl">Cancel</button>
            <button onClick={()=>onSave({...form, id: project?.id})} className="p-2 rounded-xl bg-indigo-600 text-white">Save</button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function PostModal({show, onClose, onSave, post}){
  const [form, setForm] = useState(() => post ? {...post} : {title:'', content:''})
  useEffect(()=>{ setForm(post ? {...post} : {title:'', content:''}) }, [post, show])
  if(!show) return null
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <motion.div initial={{scale:0.9, opacity:0}} animate={{scale:1, opacity:1}} exit={{scale:0.9, opacity:0}} className="w-full max-w-3xl bg-white dark:bg-gray-800 p-6 rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="font-semibold">{post ? 'Edit post' : 'New post'}</div>
          <button onClick={onClose} className="text-sm text-gray-500">Close</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <input value={form.title} onChange={e=>setForm({...form, title:e.target.value})} placeholder="Title" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700 mb-2" />
            <textarea value={form.content} onChange={e=>setForm({...form, content:e.target.value})} placeholder="Markdown content" className="w-full p-2 rounded-xl bg-gray-100 dark:bg-gray-700 h-56" />
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={onClose} className="p-2 rounded-xl">Cancel</button>
              <button onClick={()=>onSave({...form, id: post?.id, createdAt: post?.createdAt ?? new Date().toISOString()})} className="p-2 rounded-xl bg-indigo-600 text-white">Save</button>
            </div>
          </div>
          <div>
            <div className="text-sm font-semibold mb-2">Preview</div>
            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-xl h-56 overflow-auto text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{form.content || '*Write some Markdown to preview*'}</ReactMarkdown>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function sampleProjects(){
  return [
    { id: 'p1', title: 'Training Gym Website', description: 'Simple landing page and scheduling UI.', lang: 'HTML/CSS/JS', repo: '#', live: 'https://example.com' },
    { id: 'p2', title: 'Task Manager', description: 'React app with localStorage and tags.', lang: 'React', repo: '#', live: '#' }
  ]
}
function samplePosts(){
  return [
    { id: 'b1', title: 'Welcome', content: 'This is your first post. Edit or delete it!', createdAt: new Date().toISOString() }
  ]
}
