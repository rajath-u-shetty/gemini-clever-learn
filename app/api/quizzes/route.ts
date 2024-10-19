import { QuizGeneration, schema } from "@/config/schemas/quiz";
import { getAuthSession } from "@/lib/auth";
import { limitExceeded } from "@/lib/limit-exceeded";
import { getChatModel } from "@/lib/openai";
import prisma from "@/prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const session = await getAuthSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized Request", status: 401 });
  const userQuizes = await prisma.quiz.findMany({
    where: {
      userId: session.user.id,
    },
  });
  return NextResponse.json(userQuizes);
}

export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized Request", status: 401 });

  const isLimitExceeded = await limitExceeded(session);
  if (isLimitExceeded)
    return NextResponse.json({ error: "Limit exceeded", status: 401 });

  const { title, description, num, source, difficulty } =
    (await req.json()) as {
      title?: string;
      description?: string;
      num?: number;
      source?: string;
      difficulty?: "easy" | "medium" | "hard";
    };

  if (
    !title ||
    !description ||
    !num ||
    num > Number(process.env.MAX_NUM) ||
    !source ||
    !difficulty
  )
    return NextResponse.json({
      error: "Invalid request, incorrect payload",
      status: 400,
    });

  const model = getChatModel();
  const prompt = `You are a quiz generation AI. Create a quiz of ${num} questions of ${difficulty} difficulty based on this source: "${source}". There should be 5 possible answer choices for each question. Make sure the correct answer isn't the same number for each question. If the source has insufficient data, use your own information to create the quiz. Format the output as a JSON object with a "questions" array containing objects with "question", "possibleAnswers" (an array of 5 strings), and "correctAnswer" (a string matching one of the possibleAnswers) fields. Do not include any Markdown formatting or code block indicators in your response.`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("Raw response from Gemini API:", text);

    let json: QuizGeneration;
    try {
      json = JSON.parse(text) as QuizGeneration;
    } catch (parseError) {
      console.error("Error parsing JSON:", parseError);
      console.log("Text that failed to parse:", text);
      return NextResponse.json({ error: "Failed to parse quiz data", status: 500 });
    }

    console.log("Parsed JSON:", json);

    if (!json.questions || !Array.isArray(json.questions)) {
      console.error("Invalid quiz structure:", json);
      return NextResponse.json({ error: "Invalid quiz structure", status: 500 });
    }

    const generatedQuizQuestions = json.questions.map((question) => {
      if (!question.question || !Array.isArray(question.possibleAnswers) || !question.correctAnswer) {
        throw new Error("Invalid question structure");
      }
      return {
        userId: session.user.id,
        question: question.question,
        possibleAnswers: question.possibleAnswers,
        correctAnswer: question.correctAnswer,
      };
    });

    for (let i = 0; i < generatedQuizQuestions.length; i++) {
      const curr = generatedQuizQuestions[i];
      for (let j = curr.possibleAnswers.length - 1; j > 0; j--) {
        let randomIndex = Math.floor(Math.random() * (j + 1));
        let temp = curr.possibleAnswers[randomIndex];
        curr.possibleAnswers[randomIndex] = curr.possibleAnswers[j];
        curr.possibleAnswers[j] = temp;
      }
    }

    const newQuiz = await prisma.quiz.create({
      data: {
        userId: session.user.id,
        title,
        description,
        questions: {
          createMany: {
            data: generatedQuizQuestions,
          },
        },
      },
    });

    await prisma.generation.create({
      data: {
        userId: session.user.id,
        type: "quiz",
      },
    });

    return NextResponse.json(newQuiz);
  } catch (error) {
    console.error("Error generating quiz:", error);
    return NextResponse.json({ error: "Failed to generate quiz", status: 500 });
  }
}
