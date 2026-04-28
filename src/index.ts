import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
  PermissionFlagsBits,
  Message,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import Redis from 'ioredis';

interface WordEntry {
  word: string;
  userId: string;
  timestamp: number;
}

interface StoryData {
  channelId: string;
  words: WordEntry[];
  isActive: boolean;
}

interface GuildConfig {
  guildId: string;
  storyChannelId: string | null;
  currentStory: StoryData | null;
}

interface CompletedStory {
  content: string;
  completedAt: string;
  participants: string[];
  wordCount: number;
}

const configKey = (guildId: string) => `guild:${guildId}:config`;
const storiesKey = (guildId: string) => `guild:${guildId}:stories`;

class StoryBot {
  private client: Client;
  private configs: Map<string, GuildConfig> = new Map();
  private redis: Redis;
  private isReady = false;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.redis.on('error', (err) => console.error('❌ Erreur Redis:', err));

    this.setupEventListeners();
  }

  private async loadConfigsFromRedis(): Promise<void> {
    try {
      let cursor = '0';
      const keys: string[] = [];
      do {
        const [nextCursor, batch] = await this.redis.scan(
          cursor,
          'MATCH',
          'guild:*:config',
          'COUNT',
          100,
        );
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0');

      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const config = JSON.parse(raw) as GuildConfig;
        this.configs.set(config.guildId, config);
      }

      console.log(`✅ ${keys.length} configuration(s) chargée(s) depuis Redis`);
    } catch (err) {
      console.error('❌ Impossible de charger les configurations depuis Redis:', err);
    }
  }

  private async saveConfig(guildId: string): Promise<void> {
    const config = this.configs.get(guildId);
    if (!config) return;
    try {
      await this.redis.set(configKey(guildId), JSON.stringify(config));
    } catch (err) {
      console.error(`❌ Impossible de sauvegarder la config pour ${guildId}:`, err);
    }
  }

  private async appendCompletedStory(guildId: string, story: CompletedStory): Promise<void> {
    try {
      await this.redis.rpush(storiesKey(guildId), JSON.stringify(story));
    } catch (err) {
      console.error(`❌ Impossible de sauvegarder l'histoire pour ${guildId}:`, err);
    }
  }

  private async getCompletedStories(guildId: string, last = 5): Promise<CompletedStory[]> {
    try {
      const raws = await this.redis.lrange(storiesKey(guildId), -last, -1);
      return raws.map((r) => JSON.parse(r) as CompletedStory);
    } catch {
      return [];
    }
  }

  private setupEventListeners() {
    this.client.once('ready', async () => {
      await this.redis.connect().catch((err) =>
        console.error('❌ Impossible de se connecter à Redis:', err),
      );
      await this.loadConfigsFromRedis();
      this.isReady = true;
      console.log(`✅ Bot connecté en tant que ${this.client.user?.tag}`);
      this.registerCommands();
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!this.isReady) return;
      if (!interaction.isChatInputCommand()) return;
      await this.handleCommand(interaction);
    });

    this.client.on('messageCreate', async (message) => {
      if (!this.isReady) return;
      await this.handleMessage(message);
    });
  }

  private async registerCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('story-setup')
        .setDescription('Définir le channel pour les histoires collaboratives')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Le channel pour les histoires')
            .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-end')
        .setDescription("Terminer l'histoire en cours")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-reset')
        .setDescription("Réinitialiser l'histoire en cours sans la sauvegarder")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-disable')
        .setDescription("Désactiver le channel d'histoires")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-status')
        .setDescription("Voir le statut actuel de l'histoire"),
    ];

    try {
      await this.client.application?.commands.set(commands);
      console.log('✅ Commandes enregistrées');
    } catch (error) {
      console.error("❌ Erreur lors de l'enregistrement des commandes:", error);
    }
  }

  private getOrCreateConfig(guildId: string): GuildConfig {
    if (!this.configs.has(guildId)) {
      this.configs.set(guildId, {
        guildId,
        storyChannelId: null,
        currentStory: null,
      });
    }
    return this.configs.get(guildId)!;
  }

  private async handleCommand(interaction: ChatInputCommandInteraction) {
    const config = this.getOrCreateConfig(interaction.guildId!);

    switch (interaction.commandName) {
      case 'story-setup':
        await this.setupStoryChannel(interaction, config);
        break;
      case 'story-end':
        await this.endStory(interaction, config);
        break;
      case 'story-reset':
        await this.resetStory(interaction, config);
        break;
      case 'story-disable':
        await this.disableStoryChannel(interaction, config);
        break;
      case 'story-status':
        await this.showStatus(interaction, config);
        break;
    }
  }

  private async setupStoryChannel(
    interaction: ChatInputCommandInteraction,
    config: GuildConfig,
  ) {
    const channel = interaction.options.getChannel('channel', true);

    config.storyChannelId = channel.id;
    config.currentStory = { channelId: channel.id, words: [], isActive: true };

    await this.saveConfig(interaction.guildId!);

    await interaction.reply({
      content: `✅ Le channel <#${channel.id}> est maintenant configuré pour les histoires collaboratives!\n\n**Comment ça marche?**\n• Chaque membre peut envoyer **un mot** à la fois\n• L'histoire se termine automatiquement quand quelqu'un met un point (.)`,
      ephemeral: true,
    });

    const storyChannel = (await this.client.channels.fetch(channel.id)) as TextChannel;
    await storyChannel.send(
      "📖 **Nouvelle histoire collaborative!**\nEnvoyez un mot à la fois pour créer une histoire ensemble. Terminez avec un point (.) !",
    );
  }

  private async endStory(interaction: ChatInputCommandInteraction, config: GuildConfig) {
    if (!config.currentStory || config.currentStory.words.length === 0) {
      await interaction.reply({ content: '❌ Aucune histoire en cours.', ephemeral: true });
      return;
    }

    await this.completeStory(config);
    await interaction.reply({ content: '✅ Histoire terminée et sauvegardée!', ephemeral: true });
  }

  private async resetStory(interaction: ChatInputCommandInteraction, config: GuildConfig) {
    if (!config.currentStory) {
      await interaction.reply({ content: '❌ Aucune histoire en cours.', ephemeral: true });
      return;
    }

    config.currentStory.words = [];
    await this.saveConfig(interaction.guildId!);
    await interaction.reply({ content: '✅ Histoire réinitialisée!', ephemeral: true });

    const channel = (await this.client.channels.fetch(config.storyChannelId!)) as TextChannel;
    await channel.send(
      "🔄 **Histoire réinitialisée par un administrateur.**\nUne nouvelle histoire commence maintenant!",
    );
  }

  private async disableStoryChannel(
    interaction: ChatInputCommandInteraction,
    config: GuildConfig,
  ) {
    if (!config.storyChannelId) {
      await interaction.reply({
        content: "❌ Aucun channel d'histoire configuré.",
        ephemeral: true,
      });
      return;
    }

    const channelId = config.storyChannelId;
    config.storyChannelId = null;
    config.currentStory = null;

    await this.saveConfig(interaction.guildId!);
    await interaction.reply({ content: "✅ Le channel d'histoires a été désactivé.", ephemeral: true });

    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
      await channel.send("🛑 **Le système d'histoires collaboratives a été désactivé.**");
    } catch (error) {
      console.error("Erreur lors de l'envoi du message de désactivation:", error);
    }
  }

  private async showStatus(interaction: ChatInputCommandInteraction, config: GuildConfig) {
    if (!config.currentStory || config.currentStory.words.length === 0) {
      await interaction.reply({ content: '📖 Aucune histoire en cours.', ephemeral: true });
      return;
    }

    const story = config.currentStory.words.map((w) => w.word).join(' ');
    const participants = new Set(config.currentStory.words.map((w) => w.userId)).size;

    const recent = await this.getCompletedStories(config.guildId, 3);
    const recentText =
      recent.length > 0
        ? '\n\n**Dernières histoires :**\n' +
          recent
            .reverse()
            .map((s, i) => `${i + 1}. ${s.wordCount} mots — <t:${Math.floor(new Date(s.completedAt).getTime() / 1000)}:R>`)
            .join('\n')
        : '';

    await interaction.reply({
      content: `📖 **Histoire en cours** (${config.currentStory.words.length} mots, ${participants} participants)\n\n${story}${recentText}`,
      ephemeral: true,
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot) return;
    if (!message.guildId) return;

    const config = this.getOrCreateConfig(message.guildId);

    if (!config.storyChannelId || message.channelId !== config.storyChannelId) return;
    if (!config.currentStory || !config.currentStory.isActive) return;

    const content = message.content.trim();

    if (!content) {
      await message.delete().catch(() => {});
      return;
    }

    const words = content.split(/\s+/);

    if (words.length > 1) {
      await message.reply("❌ Tu ne peux envoyer qu'**un seul mot** à la fois!");
      await message.delete().catch(() => {});
      return;
    }

    const word = words[0]!;
    const hasEndingPunctuation = word.endsWith('.') || word.endsWith('!') || word.endsWith('?');

    config.currentStory.words.push({ word, userId: message.author.id, timestamp: Date.now() });

    await message.react('✅').catch(() => {});

    if (hasEndingPunctuation) {
      await this.completeStory(config);
    } else {
      await this.saveConfig(message.guildId!);
    }
  }

  private async completeStory(config: GuildConfig) {
    if (!config.currentStory || config.currentStory.words.length === 0) return;

    const story = config.currentStory.words.map((w) => w.word).join(' ');
    const participants = [...new Set(config.currentStory.words.map((w) => w.userId))];
    const completedAt = new Date();

    await this.appendCompletedStory(config.guildId, {
      content: story,
      completedAt: completedAt.toISOString(),
      participants,
      wordCount: config.currentStory.words.length,
    });

    const embed = new EmbedBuilder()
      .setColor(0x808080)
      .setTitle('📖 Histoire Terminée')
      .setDescription(`\`\`\`${story}\`\`\``)
      .addFields(
        { name: '👥 Participants', value: `${participants.length} personnes`, inline: true },
        { name: '📝 Mots', value: `${config.currentStory.words.length}`, inline: true },
        {
          name: '🕐 Heure',
          value: `<t:${Math.floor(completedAt.getTime() / 1000)}:T>`,
          inline: true,
        },
      )
      .setTimestamp(completedAt);

    const channel = (await this.client.channels.fetch(config.storyChannelId!)) as TextChannel;
    await channel.send({ embeds: [embed] });

    config.currentStory = { channelId: config.storyChannelId!, words: [], isActive: true };
    await this.saveConfig(config.guildId);

    await channel.send(
      "📖 **Nouvelle histoire!** C'est reparti pour une nouvelle aventure collaborative!",
    );
  }

  public async start(token: string) {
    try {
      await this.client.login(token);
    } catch (error) {
      console.error('❌ Erreur de connexion:', error);
      process.exit(1);
    }
  }
}

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN manquant dans les variables d'environnement");
  process.exit(1);
}

new StoryBot().start(TOKEN);
