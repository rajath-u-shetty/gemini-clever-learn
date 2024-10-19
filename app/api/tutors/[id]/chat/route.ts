import { getAuthSession } from "@/lib/auth";
import prisma from "@/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { StreamingTextResponse } from 'ai';

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await getAuthSession();
  if (!session)
    return NextResponse.json({ error: "Unauthenticated request", status: 401 });

  const body = await req.json();
  const messages = body.messages as { role: string; content: string }[] | undefined | null;
  if (!messages)
    return NextResponse.json({
      error: "Invalid request, incorrect payload",
      status: 400,
    });

  const targetTutor = await prisma.tutor.findUnique({
    where: {
      id: params.id,
      userId: session.user.id,
    },
  });
  if (!targetTutor)
    return NextResponse.json({ error: "Invalid request", status: 400 });

  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  const chat = model.startChat({
    history: [
      {
        role: "user",
        parts: [{text: `You are a tutoring AI based on this data source: ${targetTutor.source}. Respond to the user's questions appropriately based on the data source. Refuse to answer any questions unrelated to the data source.`}],
      },
      {
        role: "model",
        parts: [{text: "Understood. I am a tutoring AI based on the specified data source. I will respond to questions related to that source and refuse to answer unrelated questions. How may I assist you today?"}],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1000,
    },
  });

  const latestMessage = messages[messages.length - 1].content;

  // Save user message to database
  await prisma.message.create({
    data: {
      userId: session.user.id,
      tutorId: params.id,
      content: latestMessage,
      role: "user",
    },
  });

  const result = await chat.sendMessageStream([{text: latestMessage}]);

  let fullResponse = '';

  // Create a ReadableStream from the AsyncGenerator
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const chunk of result.stream) {
        const text = chunk.text();
        fullResponse += text;
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });

  // Use a TransformStream to save the response after streaming is complete
  const saveResponseStream = new TransformStream({
    flush: async () => {
      await prisma.message.create({
        data: {
          userId: session.user.id,
          tutorId: params.id,
          content: fullResponse,
          role: "assistant",
        },
      });
    },
  });

  // Pipe through the save response stream
  const responseStream = stream.pipeThrough(saveResponseStream);

  return new StreamingTextResponse(responseStream);
}
