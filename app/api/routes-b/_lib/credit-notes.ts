import { prisma } from '@/lib/db'
import fs from 'fs/promises'
import path from 'path'

export type CreditNote = {
  id: string
  invoiceId: string
  amount: number
  currency: string
  reason: string
  issuedAt: string
  number: string
}

const DATA_DIR = path.join(process.cwd(), 'app/api/routes-b/_lib/data')
const CREDIT_NOTES_FILE = path.join(DATA_DIR, 'credit-notes.json')

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
  } catch (e) {}
}

export async function getAllCreditNotes(userId: string): Promise<CreditNote[]> {
  await ensureDataDir()
  try {
    const data = await fs.readFile(CREDIT_NOTES_FILE, 'utf-8')
    const allNotes: Record<string, CreditNote[]> = JSON.parse(data)
    return allNotes[userId] || []
  } catch (e) {
    return []
  }
}

export async function getCreditNoteById(userId: string, id: string): Promise<CreditNote | null> {
  const notes = await getAllCreditNotes(userId)
  return notes.find(n => n.id === id) || null
}

export async function createCreditNote(
  userId: string,
  data: Omit<CreditNote, 'id' | 'number' | 'issuedAt'>
): Promise<CreditNote> {
  await ensureDataDir()
  const allData: Record<string, CreditNote[]> = {}
  try {
    const existing = await fs.readFile(CREDIT_NOTES_FILE, 'utf-8')
    Object.assign(allData, JSON.parse(existing))
  } catch (e) {}

  const userNotes = allData[userId] || []
  const year = new Date().getFullYear()
  const count = userNotes.length + 1
  const number = `CN-${year}-${String(count).padStart(4, '0')}`
  
  const newNote: CreditNote = {
    ...data,
    id: crypto.randomUUID(),
    number,
    issuedAt: new Date().toISOString()
  }

  userNotes.push(newNote)
  allData[userId] = userNotes

  await fs.writeFile(CREDIT_NOTES_FILE, JSON.stringify(allData, null, 2))

  // Record audit event
  await prisma.auditEvent.create({
    data: {
      invoiceId: data.invoiceId,
      eventType: 'credit_note.created',
      metadata: newNote as any,
      signature: 'system-credit-note'
    }
  })

  return newNote
}

export async function deleteCreditNote(userId: string, id: string): Promise<boolean> {
  await ensureDataDir()
  try {
    const data = await fs.readFile(CREDIT_NOTES_FILE, 'utf-8')
    const allData: Record<string, CreditNote[]> = JSON.parse(data)
    const userNotes = allData[userId] || []
    const index = userNotes.findIndex(n => n.id === id)
    if (index === -1) return false

    const note = userNotes[index]
    userNotes.splice(index, 1)
    allData[userId] = userNotes
    await fs.writeFile(CREDIT_NOTES_FILE, JSON.stringify(allData, null, 2))

    await prisma.auditEvent.create({
      data: {
        invoiceId: note.invoiceId,
        eventType: 'credit_note.deleted',
        metadata: { id, number: note.number } as any,
        signature: 'system-credit-note'
      }
    })

    return true
  } catch (e) {
    return false
  }
}
