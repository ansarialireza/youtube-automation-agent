const { Logger } = require('../utils/logger');
const { NotebookLMClientProvider } = require('../utils/notebooklm-client-provider');
const { AITextService } = require('../utils/ai-text-service');

class NotebookLMResearchAgent {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = options.logger || new Logger('NotebookLMResearchAgent');
    
    // Resolve credentials
    const resolved = credentials?.credentials || credentials || {};
    const nblmConfig = resolved.notebooklm || {};
    
    this.provider = options.provider || new NotebookLMClientProvider(nblmConfig, { logger: this.logger });
    this.aiTextService = options.aiTextService || new AITextService(resolved);
    this.activeNotebooks = new Map();
    this.executionHistory = [];
    this.status = 'idle'; // 'idle' | 'running' | 'error' | 'disabled'
  }

  async initialize() {
    this.logger.info('Initializing NotebookLM Research Agent...');
    if (!this.provider.enabled && process.env.NOTEBOOKLM_ENABLED !== 'true') {
      this.status = 'disabled';
      this.logger.info('NotebookLM Research Agent is disabled in configuration');
      return true;
    }

    if (this.provider.isConfigured()) {
      this.status = 'idle';
      this.logger.info('NotebookLM Research Agent initialized and ready');
    } else {
      this.status = 'unconfigured';
      this.logger.warn('NotebookLM Research Agent initialized (unconfigured credentials)');
    }
    return true;
  }

  getStatus() {
    return {
      name: 'NotebookLM Research Agent',
      id: 'notebooklm',
      status: this.status,
      enabled: this.provider.enabled || process.env.NOTEBOOKLM_ENABLED === 'true',
      isConfigured: this.provider.isConfigured(),
      activeNotebooksCount: this.activeNotebooks.size,
      executionCount: this.executionHistory.length,
      lastExecution: this.executionHistory[this.executionHistory.length - 1] || null
    };
  }

  /**
   * Create or retrieve an active notebook for a research topic
   */
  async getOrCreateNotebook(topic, options = {}) {
    if (this.activeNotebooks.has(topic)) {
      return this.activeNotebooks.get(topic);
    }

    const title = `WEIRWISE Research: ${topic}`;
    const notebook = await this.provider.createNotebook(title, options);
    this.activeNotebooks.set(topic, notebook);
    return notebook;
  }

  /**
   * Ingest and organize a collection of sources into a research notebook
   */
  async ingestSources(topic, sources = []) {
    const notebook = await this.getOrCreateNotebook(topic);
    const results = [];

    for (const source of sources) {
      try {
        const item = await this.provider.addSource(notebook.id, source);
        results.push({ ...item, success: true });
      } catch (err) {
        this.logger.warn(`Failed to add source ${source.url || source.title}: ${err.message}`);
        results.push({ source, success: false, error: err.message });
      }
    }

    return {
      notebookId: notebook.id,
      topic,
      ingestedCount: results.filter(r => r.success).length,
      totalSources: sources.length,
      sources: results
    };
  }

  /**
   * Main collaborative workflow:
   * Takes a topic and candidate sources, organizes them into a notebook,
   * analyzes facts, contradictions, and narrative arcs, and outputs a structured research bundle.
   */
  async analyzeResearchTopic(topic, sources = [], options = {}) {
    this.status = 'running';
    const executionRecord = {
      id: `exec_${Date.now()}`,
      topic,
      startedAt: new Date().toISOString(),
      status: 'running'
    };
    this.executionHistory.push(executionRecord);

    try {
      // If NotebookLM is not configured or disabled, fallback cleanly to standard AI text synthesis
      if (!this.provider.isConfigured()) {
        this.logger.info(`NotebookLM unconfigured/disabled; performing structured fallback research for "${topic}"`);
        const fallbackResult = await this.fallbackAnalyze(topic, sources);
        executionRecord.status = 'completed';
        executionRecord.mode = 'fallback_synthesis';
        executionRecord.completedAt = new Date().toISOString();
        this.status = 'idle';
        return fallbackResult;
      }

      // Step 1: Create/Get Notebook and Ingest Sources
      this.logger.info(`Ingesting ${sources.length} sources for "${topic}" into NotebookLM`);
      const ingestion = await this.ingestSources(topic, sources);

      // Step 2: Query / Synthesize deep structured research
      const synthesisPrompt = `Analyze the provided sources for the documentary topic: "${topic}".
1. Extract key verified facts, metrics, and technical specifications with their source URLs.
2. Identify major underlying mechanisms, systems, or overlooked details.
3. Highlight any contradictions, uncertainties, or debates between sources.
4. Suggest 3 compelling documentary storytelling angles aligned with WEIRWISE territories.
Provide clean, structured Markdown output.`;

      const response = await this.provider.queryNotebook(ingestion.notebookId, synthesisPrompt, options);

      const researchBundle = {
        topic,
        notebookId: ingestion.notebookId,
        provider: 'notebooklm',
        mode: this.provider.mode,
        summary: response.answer,
        citations: response.citations || [],
        sources: ingestion.sources,
        generatedAt: new Date().toISOString()
      };

      executionRecord.status = 'completed';
      executionRecord.completedAt = new Date().toISOString();
      this.status = 'idle';
      return researchBundle;

    } catch (err) {
      this.status = 'error';
      executionRecord.status = 'failed';
      executionRecord.error = err.message;
      executionRecord.completedAt = new Date().toISOString();
      this.logger.error(`NotebookLM research failed for "${topic}": ${err.message}`);
      
      // Fallback if requested
      if (options.allowFallback !== false) {
        this.logger.info(`Attempting fallback research synthesis after NotebookLM error...`);
        const fallback = await this.fallbackAnalyze(topic, sources);
        this.status = 'idle';
        return fallback;
      }
      throw err;
    }
  }

  /**
   * Fallback research analysis when NotebookLM provider is unavailable
   */
  async fallbackAnalyze(topic, sources = []) {
    const prompt = `You are a research analyst for a high-end YouTube documentary channel.
Topic: "${topic}"
Available sources:
${JSON.stringify(sources.slice(0, 8), null, 2)}

Provide a structured research synthesis with:
1. Executive Summary & Overview
2. Verified Key Claims & Statistics
3. Key Technical Mechanisms
4. 3 Narrative Story Angles`;

    const summary = await this.aiTextService.generateText(prompt, { maxTokens: 1200 });

    return {
      topic,
      provider: 'fallback_ai_text',
      notebookId: null,
      summary,
      citations: sources.map(s => ({ title: s.title || s.url, sourceUrl: s.url })),
      sources,
      generatedAt: new Date().toISOString()
    };
  }
}

module.exports = { NotebookLMResearchAgent };
