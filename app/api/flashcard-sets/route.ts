import { FlashcardGeneration, schema } from "@/config/schemas/flashcard-set";
import { getAuthSession } from "@/lib/auth";
import { limitExceeded } from "@/lib/limit-exceeded";
import prisma from "@/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getChatModel } from "@/lib/openai";

export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized Request", status: 401 });

  const isLimitExceeded = await limitExceeded(session);
  if (isLimitExceeded)
    return NextResponse.json({ error: "Limit exceeded", status: 401 });

  const { source, num, title, description, difficulty } =
    (await req.json()) as {
      source?: string;
      num?: number;
      title?: string;
      description?: string;
      difficulty?: "easy" | "medium" | "hard";
    };

  if (
    !source ||
    !num ||
    num > Number(process.env.MAX_NUM) ||
    !title ||
    !description ||
    !difficulty
  )
    return NextResponse.json({
      error: "Invalid request, incorrect payload",
      status: 400,
    });

  const model = getChatModel();
  const prompt = `You are a flashcard set generation AI. Create a flashcard set of ${num} cards of ${difficulty} difficulty based on this source: "${source}". If the source has insufficient data, use your own information to create the flashcards. Format the output as a JSON object with a "flashcards" array containing objects with "question" and "answer" fields. Do not include any Markdown formatting or code block indicators in your response.`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("Raw response from Gemini API:", text);

    // Function to extract JSON from the response, handling potential Markdown formatting
    const extractJsonFromResponse = (str: string) => {
      // Remove Markdown code block indicators if present
      let cleaned = str.replace(/```json\s*|\s*```/g, '');
      // Attempt to find a valid JSON object
      const match = cleaned.match(/\{[\s\S]*\}/);
      return match ? match[0] : cleaned;
    };

    const jsonString = extractJsonFromResponse(text);
    console.log("Extracted JSON string:", jsonString);

    let json: FlashcardGeneration;
    try {
      json = JSON.parse(jsonString) as FlashcardGeneration;
    } catch (parseError) {
      console.error("Error parsing JSON:", parseError);
      console.log("JSON string that failed to parse:", jsonString);
      return NextResponse.json({ error: "Failed to parse flashcard data", status: 500 });
    }

    console.log("Parsed JSON:", json);

    if (!json.flashcards || !Array.isArray(json.flashcards)) {
      console.error("Invalid flashcard set structure:", json);
      return NextResponse.json({ error: "Invalid flashcard set structure", status: 500 });
    }

    const generatedSet = json.flashcards.map((flashcard) => {
      if (!flashcard.question || !flashcard.answer) {
        throw new Error("Invalid flashcard structure");
      }
      return {
        userId: session.user.id,
        question: flashcard.question,
        answer: flashcard.answer,
      };
    });

    const newFlashcardSet = await prisma.flashcardSet.create({
      data: {
        title,
        description,
        userId: session.user.id,
        flashcards: {
          createMany: {
            data: generatedSet,
          },
        },
      },
    });

    await prisma.generation.create({
      data: {
        userId: session.user.id,
        type: "flashcard-set",
      },
    });

    return NextResponse.json(newFlashcardSet);
  } catch (error) {
    console.error("Error generating flashcard set:", error);
    return NextResponse.json({ error: "Failed to generate flashcard set", status: 500 });
  }
}
