import { loadEnvLocal } from "./scripts/_env.mjs";
loadEnvLocal();
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY not found");
  process.exit(1);
}

fetch("https://api.groq.com/openai/v1/models", {
  headers: {
    "Authorization": `Bearer ${apiKey}`,
  }
})
.then(res => res.json())
.then(data => {
  console.log("Available models:");
  data.data.forEach(model => {
    console.log(`- ${model.id}`);
  });
})
.catch(err => {
  console.error("Error fetching models:", err);
});