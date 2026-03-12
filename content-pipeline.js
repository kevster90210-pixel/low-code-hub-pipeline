#!/usr/bin/env node

/**
   * The Low Code Hub - Automated Content Pipeline
   * RSS -> OpenAI -> Creatomate -> Vizard -> YouTube
   *
   * SETUP: Fill in the CONFIG section below, then run:
   *   npm install axios rss-parser
   *   node content-pipeline.js
   *
   * To run on a schedule, use cron or deploy to Railway/Render.
   */

const axios = require("axios");
const RSSParser = require("rss-parser");
const fs = require("fs");

// ─────────────────────────────────────────
// CONFIG - Fill these in
// ─────────────────────────────────────────
const CONFIG = {
    // RSS Feed
    rssUrl: process.env.RSS_URL,

    // OpenAI
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: "gpt-4o-mini",

    // Creatomate
    creatomateApiKey: process.env.CREATOMATE_API_KEY,
    creatomateTemplateId: "dced4557-2242-4e48-8061-e6b0644d4939",

    // Vizard
    vizardApiKey: "a7fcc89a8af74b36bc93284117404fe6",
    vizardSocialAccountId: "dml6YXJkLTEtMTc2Mzlx", // The Low Code Hub YouTube

    // Tracking - keeps a local log of processed article URLs so we don't repeat
    processedLogFile: "./processed-articles.json",
};

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function log(step, msg) {
    console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function loadProcessed() {
    if (!fs.existsSync(CONFIG.processedLogFile)) return [];
    return JSON.parse(fs.readFileSync(CONFIG.processedLogFile, "utf8"));
}

function saveProcessed(urls) {
    fs.writeFileSync(CONFIG.processedLogFile, JSON.stringify(urls, null, 2));
}

// ─────────────────────────────────────────
// STEP 1 - Fetch new articles from RSS
// ─────────────────────────────────────────
async function fetchNewArticles() {
    log("RSS", "Fetching feed...");
    const parser = new RSSParser();
    const feed = await parser.parseURL(CONFIG.rssUrl);
    const processed = loadProcessed();
    const newArticles = feed.items.filter((item) => !processed.includes(item.link));
    log("RSS", `Found ${newArticles.length} new article(s)`);
    return newArticles;
}

// ─────────────────────────────────────────
// STEP 2 - Generate script with OpenAI
// ─────────────────────────────────────────
async function generateScript(article) {
    log("OpenAI", `Generating script for: ${article.title}`);
    const prompt = `You are a tech content creator for "The Low Code Hub" YouTube channel.
    Write a short, engaging video script (60-90 seconds when read aloud) based on this article:

    Title: ${article.title}
    Content: ${article.contentSnippet || article.summary || article.content || ""}

    Rules:
    - Start with a hook that grabs attention
    - Explain the topic simply for a business/no-code audience
    - End with a call to action to like and subscribe
    - No hashtags, no markdown, just plain spoken text
    - Keep it conversational and energetic`;

  const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
    {
            model: CONFIG.openaiModel,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 600,
    },
    {
            headers: {
                      Authorization: `Bearer ${CONFIG.openaiApiKey}`,
                      "Content-Type": "application/json",
            },
    }
      );

  const script = response.data.choices[0].message.content.trim();
    log("OpenAI", "Script generated OK");
    return script;
}

// ─────────────────────────────────────────
// STEP 3 - Render video with Creatomate
// ─────────────────────────────────────────
async function renderVideo(title, script) {
    log("Creatomate", "Submitting render job...");
    const response = await axios.post(
          "https://api.creatomate.com/v1/renders",
      {
              template_id: CONFIG.creatomateTemplateId,
              modifications: {
                        Script: script,
                        Title: title,
              },
      },
      {
              headers: {
                        Authorization: `Bearer ${CONFIG.creatomateApiKey}`,
                        "Content-Type": "application/json",
              },
      }
        );

  const renderId = response.data[0]?.id;
    log("Creatomate", `Render started - ID: ${renderId}`);
    return renderId;
}

// ─────────────────────────────────────────
// STEP 4 - Poll Creatomate until done
// ─────────────────────────────────────────
async function waitForRender(renderId) {
    log("Creatomate", "Waiting for render to complete...");
    for (let i = 0; i < 20; i++) {
          await sleep(30000);
          const response = await axios.get(
                  `https://api.creatomate.com/v1/renders/${renderId}`,
            {
                      headers: { Authorization: `Bearer ${CONFIG.creatomateApiKey}` },
            }
                );
          const { status, url } = response.data;
          log("Creatomate", `Status: ${status}`);
          if (status === "succeeded") {
                  log("Creatomate", `Render complete - ${url}`);
                  return url;
          }
          if (status === "failed") {
                  throw new Error(`Creatomate render failed: ${response.data.error_message}`);
          }
    }
    throw new Error("Creatomate render timed out after 10 minutes");
}

// ─────────────────────────────────────────
// STEP 5 - Submit video to Vizard
// ─────────────────────────────────────────
async function submitToVizard(videoUrl) {
    log("Vizard", "Submitting video for processing...");
    const response = await axios.post(
          "https://elb-api.vizard.ai/hvizard-server-front/open-api/v1/project/create",
      {
              videoUrl: videoUrl,
              videoType: 1,
              ext: "mp4",
              lang: "en",
              preferLength: [0],
      },
      {
              headers: {
                        "VIZARDAI_API_KEY": CONFIG.vizardApiKey,
                        "Content-Type": "application/json",
              },
      }
        );

  const projectId = response.data?.data?.projectId;
    log("Vizard", `Project created - ID: ${projectId}`);
    return projectId;
}

// ─────────────────────────────────────────
// STEP 6 - Poll Vizard until clips are ready
// ─────────────────────────────────────────
async function waitForVizard(projectId) {
    log("Vizard", "Waiting for clips to be processed...");
    for (let i = 0; i < 20; i++) {
          await sleep(30000);
          const response = await axios.get(
                  `https://elb-api.vizard.ai/hvizard-server-front/open-api/v1/project/query/${projectId}`,
            {
                      headers: { "VIZARDAI_API_KEY": CONFIG.vizardApiKey },
            }
                );
          const { code, videos } = response.data;
          log("Vizard", `Status code: ${code}`);
          if (code === 2000 && videos?.length > 0) {
                  const topClip = videos[0];
                  log("Vizard", `Clips ready - Top clip videoId: ${topClip.videoId}`);
                  return topClip.videoId;
          }
          if (code === 1000) {
                  log("Vizard", "Still processing, waiting...");
                  continue;
          }
          if (code >= 4000) {
                  throw new Error(`Vizard processing failed with code: ${code}`);
          }
    }
    throw new Error("Vizard processing timed out after 10 minutes");
}

// ─────────────────────────────────────────
// STEP 7 - Publish to YouTube via Vizard
// ─────────────────────────────────────────
async function publishToYouTube(videoId, title) {
    log("Vizard", `Publishing to YouTube - videoId: ${videoId}`);
    const response = await axios.post(
          "https://elb-api.vizard.ai/hvizard-server-front/open-api/v1/project/publish-video",
      {
              finalVideoId: videoId,
              socialAccountId: CONFIG.vizardSocialAccountId,
              title: title,
              post: "",
      },
      {
              headers: {
                        "VIZARDAI_API_KEY": CONFIG.vizardApiKey,
                        "Content-Type": "application/json",
              },
      }
        );

  if (response.data.code === 2000) {
        log("Vizard", "Published to YouTube - SUCCESS");
  } else {
        throw new Error(`Publish failed: ${response.data.errMsg}`);
  }
}

// ─────────────────────────────────────────
// MAIN - Run the full pipeline
// ─────────────────────────────────────────
async function main() {
    log("PIPELINE", "Starting content pipeline...");
    try {
          const articles = await fetchNewArticles();
          if (articles.length === 0) {
                  log("PIPELINE", "No new articles. Done.");
                  return;
          }

      const processed = loadProcessed();

      for (const article of articles) {
              log("PIPELINE", `Processing: ${article.title}`);
              try {
                        const script = await generateScript(article);
                        const renderId = await renderVideo(article.title, script);
                        const videoUrl = await waitForRender(renderId);
                        const projectId = await submitToVizard(videoUrl);
                        const clipVideoId = await waitForVizard(projectId);
                        await publishToYouTube(clipVideoId, article.title);

                processed.push(article.link);
                        saveProcessed(processed);
                        log("PIPELINE", `Successfully published: ${article.title}`);
              } catch (err) {
                        log("ERROR", `Failed for article "${article.title}": ${err.message}`);
              }
      }

      log("PIPELINE", "All articles processed. Done!");
    } catch (err) {
          log("ERROR", `Pipeline failed: ${err.message}`);
          process.exit(1);
    }
}

main();
