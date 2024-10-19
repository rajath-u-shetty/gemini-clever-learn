import { GoogleGenerativeAI } from "@google/generative-ai";

// Check if the API key is defined
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not defined in the environment variables");
}

// Create and export the Gemini API instance
export const geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to get a chat model
export function getChatModel(model: string = "gemini-pro") {
  return geminiAI.getGenerativeModel({ model });
}
