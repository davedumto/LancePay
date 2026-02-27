import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest) {
    try {
        const { keywords } = await req.json();

        if (!keywords || typeof keywords !== 'string') {
            return NextResponse.json({ error: 'Keywords are required' }, { status: 400 });
        }

        logger.info({ keywords }, 'Generating invoice description');

        const { text } = await generateText({
            model: openai('gpt-4o'),
            system: `You are a professional business assistant. 
      Your task is to convert simple keywords into a professional, clear, and itemized invoice description. 
      The tone should be formal and suitable for a freelance or business invoice. 
      Format the output as a concise paragraph or a clear list if multiple items are detected.
      Avoid fluff and focus on clarity.`,
            prompt: `Translate these keywords into a professional invoice description: ${keywords}`,
        });

        return NextResponse.json({ description: text });
    } catch (error) {
        logger.error({ err: error }, 'Failed to generate invoice description');
        return NextResponse.json(
            { error: 'Failed to generate description' },
            { status: 500 }
        );
    }
}
