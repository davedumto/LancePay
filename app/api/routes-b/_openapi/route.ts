import { NextRequest, NextResponse } from 'next/server'
import { generateOpenAPIDocument } from '../_lib/openapi'

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 
                  `https://${request.headers.get('host')}` ||
                  'http://localhost:3000'
  
  const doc = generateOpenAPIDocument(baseUrl)
  
  return NextResponse.json(doc, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  })
}