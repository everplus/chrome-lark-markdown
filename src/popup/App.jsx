import React, { useState, useEffect } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import ErrorIcon from '@mui/icons-material/Error'

const STEPS = [
  { id: 'step-scroll', label: 'Loading full content' },
  { id: 'step-extract', label: 'Extracting document' },
  { id: 'step-convert', label: 'Converting to Markdown' },
  { id: 'step-preview', label: 'Opening preview' },
]

const BREADCRUMB_SELECTOR = '.wiki-suite-title__inner-wrapper > :first-child > :last-child .breadcrumb-container-item__text'
const FALLBACK_BREADCRUMB_SELECTOR = '.note-title__input-and-star .breadcrumb-container-item :first-child :last-child, .note-title__input-and-star .note-title__input :first-child'

const stepIcons = {
  done: <CheckCircleIcon fontSize="small" color="success" />,
  active: <PlayArrowIcon fontSize="small" color="primary" />,
  error: <ErrorIcon fontSize="small" color="error" />,
  pending: <RadioButtonUncheckedIcon fontSize="small" sx={{ color: '#bbb' }} />,
}

export default function App() {
  const [isFeishu, setIsFeishu] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({})
  const [error, setError] = useState('')

  useEffect(() => {
    detectPage()
    chrome.tabs.onActivated.addListener(() => detectPage())

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PROGRESS') {
        setProgress((prev) => ({ ...prev, [msg.step]: msg.state }))
      }
      if (msg.type === 'DONE') {
        setBusy(false)
      }
      if (msg.type === 'ERROR') {
        setProgress((prev) => ({ ...prev, [msg.step]: 'error' }))
        setError(msg.error || 'Unknown error')
        setBusy(false)
      }
    })
  }, [])

  async function detectPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.url) return
      const hostname = new URL(tab.url).hostname
      const feishu =
        hostname.endsWith('feishu.cn') ||
        hostname.endsWith('feishu-3rd-party-services.com') ||
        hostname.endsWith('larksuite.com') ||
        hostname.endsWith('larkenterprise.com')

      setIsFeishu(feishu)

      if (feishu) {
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (primary, fallback) => {
              let breadcrumbs = Array.from(document.querySelectorAll(primary))
                .map((i) => i.textContent)
                .filter(Boolean)
              if (breadcrumbs.length === 0) {
                breadcrumbs = Array.from(document.querySelectorAll(fallback))
                  .map((x) => x.textContent)
                  .filter(Boolean)
              }
              const ZW_RE = new RegExp('\u200b-\u200f\u2028-\u202f\ufeff', 'g')
              const clean = (s) => s.replace(ZW_RE, '').trim()
              return breadcrumbs.length > 0
                ? clean(breadcrumbs[breadcrumbs.length - 1])
                : ''
            },
            args: [BREADCRUMB_SELECTOR, FALLBACK_BREADCRUMB_SELECTOR],
          })
          setTitle(result?.result || tab.title || 'Feishu Doc')
        } catch (_) {
          setTitle(tab.title || 'Feishu Doc')
        }
      }
    } catch (_) {}
  }

  async function handleConvert() {
    if (busy) return
    setBusy(true)
    setError('')
    setProgress({})

    try {
      const response = await chrome.runtime.sendMessage({ type: 'EXTRACT_AND_CONVERT' })
      if (response?.error) throw new Error(response.error)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const hasProgress = Object.keys(progress).length > 0

  return (
    <Box sx={{ width: 340, bgcolor: '#f5f6f7', minHeight: '100vh' }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5 }}>
          Feishu Doc to Markdown
        </Typography>

        {isFeishu ? (
          <Paper sx={{ p: 1.5, mb: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              Current Document
            </Typography>
            <Typography variant="body2" fontWeight={500} sx={{ wordBreak: 'break-all' }}>
              {title}
            </Typography>
          </Paper>
        ) : (
          <Paper sx={{ p: 1.5, mb: 1.5, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              Current page is not a Feishu document
            </Typography>
          </Paper>
        )}

        {hasProgress && (
          <Paper sx={{ p: 1.5, mb: 1.5 }}>
            <Stack spacing={0.5}>
              {STEPS.map((step) => {
                const state = progress[step.id] || 'pending'
                return (
                  <Box key={step.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    {stepIcons[state]}
                    <Typography
                      variant="body2"
                      color={
                        state === 'done'
                          ? 'success.main'
                          : state === 'active'
                            ? 'primary.main'
                            : state === 'error'
                              ? 'error.main'
                              : 'text.disabled'
                      }
                      fontWeight={state === 'active' ? 600 : 400}
                    >
                      {step.label}
                    </Typography>
                  </Box>
                )
              })}
            </Stack>
          </Paper>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {error}
          </Alert>
        )}

        <Button
          fullWidth
          variant="contained"
          size="large"
          disabled={!isFeishu || busy}
          onClick={handleConvert}
          startIcon={busy ? <CircularProgress size={18} color="inherit" /> : null}
        >
          {busy ? 'Converting...' : 'Extract & Convert'}
        </Button>
      </Box>
    </Box>
  )
}
