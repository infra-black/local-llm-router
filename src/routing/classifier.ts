/**
 * Heuristic classifier. Inspects the request and emits a tag set used by the
 * policy engine. Cheap, fast, deterministic. Replace with a tiny model
 * classifier if you outgrow heuristics.
 */
export interface Classification {
  task: 'code' | 'web_search' | 'summarisation' | 'classification' | 'general'
  complexity: 'low' | 'medium' | 'high'
  sensitivity: 'normal' | 'high'
  modalities: Modality[]
  tokens: number
}

// --- Modality detection ---

/** Maps content-part `type` values to modalities across API families. */
const TYPE_TO_MODALITY: Record<string, Modality> = {
  image_url: 'image',
  input_audio: 'audio',
  video_url: 'video',
  file: 'file',
  image: 'image',
  document: 'file',
  audio: 'audio',
  video: 'video',
}

/** MIME-prefix to modality for Gemini-style inline_data/file_data parts. */
const MIME_TO_MODALITY: Record<string, Modality> = {
  'image/': 'image',
  'audio/': 'audio',
  'video/': 'video',
  'application/pdf': 'file',
}

function modalityFromPart(part: any): Modality | null {
  // 1. Explicit `type` field (OpenAI, Anthropic, Z.AI, MiniMax)
  if (part.type && part.type !== 'text') {
    return TYPE_TO_MODALITY[part.type] ?? 'file'   // unknown type -> file
  }

  // 2. Gemini-style inline_data with mime_type
  if (part.inline_data?.mime_type) {
    const mime: string = part.inline_data.mime_type
    for (const [prefix, mod] of Object.entries(MIME_TO_MODALITY)) {
      if (mime.startsWith(prefix)) return mod
    }
    return 'file'   // unrecognised MIME -> file
  }

  // 3. Gemini-style file_data (deferred upload — can't know MIME cheaply)
  if (part.file_data) return 'file'

  return null   // plain text or not a modality-bearing part
}

function detectModalities(body: any): Modality[] {
  const messages = body.messages || []
  const found = new Set<<Modality>()
  found.add('text')   // text is always present

  for (const msg of messages) {
    const content = msg.content
    if (typeof content === 'string') continue   // plain text, already counted

    if (Array.isArray(content)) {
      for (const part of content) {
        const mod = modalityFromPart(part)
        if (mod) found.add(mod)
      }
    }
  }

  return [...found]
}

// --- Task / complexity / sensitivity heuristics ---

const CODE_HINTS = /\b(function|class|async|await|import|return|const |let |var |def |sql|select|insert|update|delete|grep|sed|awk|regex|debug|stacktrace)\b/i
const SEARCH_HINTS = /\b(today|latest|current|now|recent|news|live|price|stock|exchange rate|weather)\b/i
const SUMMARY_HINTS = /\b(summari[sz]e|tl;?dr|in (\d+) (sentences|words)|short version|key points)\b/i

export function classify(body: any, sensitivityHeader: string): Classification {
  const messages = body.messages || []
  const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
  const text = lastUser?.content || ''
  const length = (typeof text === 'string' ? text : JSON.stringify(text)).length
  const tokens = Math.ceil(length / 4)

  let task: Classification['task'] = 'general'
  if (CODE_HINTS.test(text)) task = 'code'
  else if (SEARCH_HINTS.test(text)) task = 'web_search'
  else if (SUMMARY_HINTS.test(text)) task = 'summarisation'

  let complexity: Classification['complexity'] = 'medium'
  if (tokens < 100) complexity = 'low'
  else if (tokens > 2000) complexity = 'high'

  const sensitivity: Classification['sensitivity'] =
    sensitivityHeader === 'high' ? 'high' : 'normal'

  const modalities = detectModalities(body)
  return { task, complexity, sensitivity, modalities, tokens }
}
