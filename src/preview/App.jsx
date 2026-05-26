import React, { useState, useEffect, useRef } from 'react'
import Box from '@mui/material/Box'
import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import SaveAltIcon from '@mui/icons-material/SaveAlt'
import CodeIcon from '@mui/icons-material/Code'
import ViewQuiltIcon from '@mui/icons-material/ViewQuilt'
import { marked } from 'marked'
import './markdown.css'

marked.setOptions({ gfm: true, breaks: false })

export default function App() {
  const [markdown, setMarkdown] = useState('')
  const [title, setTitle] = useState('Feishu Doc')
  const [imageMap, setImageMap] = useState({})
  const [isRaw, setIsRaw] = useState(false)
  const [toast, setToast] = useState('')
  const renderedRef = useRef(null)

  useEffect(() => {
    chrome.storage.local.get(['_previewMarkdown', '_previewTitle', '_previewImages'], (result) => {
      const md = result._previewMarkdown || ''
      const t = result._previewTitle || 'Feishu Doc'
      const imgs = result._previewImages || {}

      setMarkdown(md)
      setTitle(t)
      setImageMap(imgs)
      document.title = t + ' - Markdown Preview'

      chrome.storage.local.remove(['_previewMarkdown', '_previewTitle', '_previewImages'])
    })
  }, [])

  useEffect(() => {
    if (!isRaw && renderedRef.current && Object.keys(imageMap).length > 0) {
      const imgs = renderedRef.current.querySelectorAll('img')
      imgs.forEach((img) => {
        const src = img.getAttribute('src')
        if (src && imageMap[src]) {
          img.setAttribute('src', imageMap[src])
        }
      })
    }
  }, [markdown, imageMap, isRaw])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setToast('Copied to clipboard')
    } catch (_) {
      const ta = document.createElement('textarea')
      ta.value = markdown
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setToast('Copied to clipboard')
    }
  }

  const handleSave = async () => {
    const fileName = title.replace(/[/\\:*?"<>|]/g, '_') + '.md'

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'Markdown file', accept: { 'text/markdown': ['.md'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(markdown)
        await writable.close()
        setToast('File saved')
        return
      } catch (err) {
        if (err.name === 'AbortError') return
      }
    }

    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setToast('File downloaded')
  }

  const renderedHtml = marked.parse(markdown)

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#f6f8fa' }}>
      <AppBar position="sticky" color="default" elevation={1} sx={{ bgcolor: '#fff' }}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }} noWrap>
            {title}
          </Typography>
          <Button
            size="small"
            startIcon={isRaw ? <ViewQuiltIcon /> : <CodeIcon />}
            onClick={() => setIsRaw(!isRaw)}
            variant={isRaw ? 'contained' : 'outlined'}
            color="primary"
          >
            {isRaw ? 'Rendered' : 'Source'}
          </Button>
          <Button size="small" startIcon={<ContentCopyIcon />} variant="outlined" onClick={handleCopy}>
            Copy
          </Button>
          <Button size="small" variant="contained" startIcon={<SaveAltIcon />} onClick={handleSave}>
            Save
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ maxWidth: 980, mx: 'auto', p: 3 }}>
        {!isRaw ? (
          <Box
            ref={renderedRef}
            className="markdown-body"
            sx={{ bgcolor: '#fff', border: '1px solid #d0d7de', borderRadius: 2, p: '40px 48px' }}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : (
          <Box
            component="pre"
            sx={{
              bgcolor: '#fff',
              border: '1px solid #d0d7de',
              borderRadius: 2,
              p: 3,
              fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word',
            }}
          >
            {markdown}
          </Box>
        )}
      </Box>

      <Snackbar
        open={!!toast}
        autoHideDuration={2000}
        onClose={() => setToast('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setToast('')} severity="success" variant="filled" sx={{ width: '100%' }}>
          {toast}
        </Alert>
      </Snackbar>
    </Box>
  )
}
