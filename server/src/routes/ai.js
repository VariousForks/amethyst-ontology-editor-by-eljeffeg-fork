import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { AIServiceError, chatCompletion, fetchModels } from "../services/aiService.js";
import { getOntology, getProject } from "../services/authDb.js";
import { ensureFreshToken } from "../services/githubService.js";
import { exportOntologyAsTurtle } from "../services/rdfStore.js";

const router = Router();

async function requireGitHubToken(req, res, next) {
  const cred = await ensureFreshToken(req.session.user.id);
  if (!cred?.token) {
    return res
      .status(401)
      .json({ error: "GitHub account not connected", code: "github_not_connected" });
  }
  req.githubToken = cred.token;
  next();
}

// GET /api/ai/models — list available models
router.get("/models", requireAuth, async (_req, res) => {
  try {
    res.json({ models: await fetchModels() });
  } catch {
    res.status(502).json({ error: "Failed to fetch models" });
  }
});

// POST /api/ai/chat — streaming SSE chat completion
router.post("/chat", requireAuth, requireGitHubToken, async (req, res) => {
  const { messages = [], model, ontologyId, entityIri } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }

  // Build system context
  const systemParts = [
    "You are an expert ontology engineer helping users understand and improve their ontologies.",
    "Answer clearly and concisely. Use Turtle/SPARQL syntax in code blocks where helpful.",
  ];

  if (ontologyId) {
    try {
      const onto = await getOntology(ontologyId);
      if (onto) {
        // Include repo README if available
        if (onto.project_id) {
          const project = await getProject(onto.project_id);
          if (project?.github_repo) {
            try {
              const { fetchRepoReadme } = await import("../services/githubService.js");
              const readme = await fetchRepoReadme(
                req.githubToken,
                ...project.github_repo.split("/"),
              );
              if (readme) {
                systemParts.push(
                  `\n## Repository README (${project.github_repo})\n${readme.slice(0, 4000)}`,
                );
              }
            } catch {
              // README is best-effort
            }
          }
        }

        // Include ontology content
        try {
          const turtle = await exportOntologyAsTurtle(ontologyId);
          if (turtle) {
            const truncated =
              turtle.length > 80_000 ? `${turtle.slice(0, 80_000)}\n# [truncated]` : turtle;
            systemParts.push(`\n## Ontology: ${onto.name}\n\`\`\`turtle\n${truncated}\n\`\`\``);
          }
        } catch {
          // Ontology export is best-effort
        }
      }
    } catch {
      // Context is best-effort
    }
  }

  if (entityIri) {
    systemParts.push(`\nThe user is currently focused on entity: <${entityIri}>`);
  }

  const systemMessage = { role: "system", content: systemParts.join("\n") };
  const allMessages = [systemMessage, ...messages];

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const upstream = await chatCompletion(req.githubToken, allMessages, {
      model,
      stream: true,
      signal: req.socket.destroyed ? AbortSignal.abort() : undefined,
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep partial line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) send({ type: "delta", content: delta });
          } catch {
            // skip malformed chunk
          }
        }
      }
    }

    send({ type: "done" });
  } catch (err) {
    if (err instanceof AIServiceError) {
      send({ type: "error", message: err.message, status: err.status });
    } else {
      send({ type: "error", message: "AI service error" });
    }
  } finally {
    res.end();
  }
});

export default router;
