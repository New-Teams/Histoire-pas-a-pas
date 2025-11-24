// src/index.ts
import 'dotenv/config';
import { 
  Client, 
  GatewayIntentBits, 
  TextChannel, 
  EmbedBuilder,
  PermissionFlagsBits,
  Message,
  ChatInputCommandInteraction,
  SlashCommandBuilder
} from 'discord.js';

interface StoryData {
  channelId: string;
  words: Array<{ word: string; userId: string; timestamp: number }>;
  isActive: boolean;
}

interface GuildConfig {
  guildId: string;
  storyChannelId: string | null;
  currentStory: StoryData | null;
  completedStories: Array<{
    content: string;
    completedAt: Date;
    participants: string[];
  }>;
}

class StoryBot {
  private client: Client;
  private configs: Map<string, GuildConfig> = new Map();

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.client.once('ready', () => {
      console.log(`✅ Bot connecté en tant que ${this.client.user?.tag}`);
      this.registerCommands();
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleCommand(interaction);
    });

    this.client.on('messageCreate', async (message) => {
      await this.handleMessage(message);
    });
  }

  private async registerCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('story-setup')
        .setDescription('Définir le channel pour les histoires collaboratives')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Le channel pour les histoires')
            .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-end')
        .setDescription('Terminer l\'histoire en cours')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-reset')
        .setDescription('Réinitialiser l\'histoire en cours sans la sauvegarder')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-disable')
        .setDescription('Désactiver le channel d\'histoires')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      new SlashCommandBuilder()
        .setName('story-status')
        .setDescription('Voir le statut actuel de l\'histoire'),
    ];

    try {
      await this.client.application?.commands.set(commands);
      console.log('✅ Commandes enregistrées');
    } catch (error) {
      console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
    }
  }

  private getOrCreateConfig(guildId: string): GuildConfig {
    if (!this.configs.has(guildId)) {
      this.configs.set(guildId, {
        guildId,
        storyChannelId: null,
        currentStory: null,
        completedStories: [],
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
    config: GuildConfig
  ) {
    const channel = interaction.options.getChannel('channel', true);

    config.storyChannelId = channel.id;
    config.currentStory = {
      channelId: channel.id,
      words: [],
      isActive: true,
    };

    await interaction.reply({
      content: `✅ Le channel <#${channel.id}> est maintenant configuré pour les histoires collaboratives!\n\n**Comment ça marche?**\n• Chaque membre peut envoyer **un mot** à la fois\n• L'histoire se termine automatiquement quand quelqu'un met un point (.)`,
      ephemeral: true,
    });

    const storyChannel = await this.client.channels.fetch(channel.id) as TextChannel;
    await storyChannel.send('📖 **Nouvelle histoire collaborative!**\nEnvoyez un mot à la fois pour créer une histoire ensemble. Terminez avec un point (.) !');
  }

  private async endStory(
    interaction: ChatInputCommandInteraction,
    config: GuildConfig
  ) {
    if (!config.currentStory || config.currentStory.words.length === 0) {
      await interaction.reply({
        content: '❌ Aucune histoire en cours.',
        ephemeral: true,
      });
      return;
    }

    await this.completeStory(config);
    await interaction.reply({
      content: '✅ Histoire terminée et sauvegardée!',
      ephemeral: true,
    });
  }

  private async resetStory(
    interaction: ChatInputCommandInteraction,
    config: GuildConfig
  ) {
    if (!config.currentStory) {
      await interaction.reply({
        content: '❌ Aucune histoire en cours.',
        ephemeral: true,
      });
      return;
    }

    config.currentStory.words = [];
    await interaction.reply({
      content: '✅ Histoire réinitialisée!',
      ephemeral: true,
    });

    const channel = await this.client.channels.fetch(config.storyChannelId!) as TextChannel;
    await channel.send('🔄 **Histoire réinitialisée par un administrateur.**\nUne nouvelle histoire commence maintenant!');
  }

  private async disableStoryChannel(
    interaction: ChatInputCommandInteraction,
    config: GuildConfig
  ) {
    if (!config.storyChannelId) {
      await interaction.reply({
        content: '❌ Aucun channel d\'histoire configuré.',
        ephemeral: true,
      });
      return;
    }

    const channelId = config.storyChannelId;
    config.storyChannelId = null;
    config.currentStory = null;

    await interaction.reply({
      content: `✅ Le channel d'histoires a été désactivé.`,
      ephemeral: true,
    });

    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      await channel.send('🛑 **Le système d\'histoires collaboratives a été désactivé.**');
    } catch (error) {
      console.error('Erreur lors de l\'envoi du message de désactivation:', error);
    }
  }

  private async showStatus(
    interaction: ChatInputCommandInteraction,
    config: GuildConfig
  ) {
    if (!config.currentStory || config.currentStory.words.length === 0) {
      await interaction.reply({
        content: '📖 Aucune histoire en cours.',
        ephemeral: true,
      });
      return;
    }

    const story = config.currentStory.words.map(w => w.word).join(' ');
    const participants = new Set(config.currentStory.words.map(w => w.userId)).size;

    await interaction.reply({
      content: `📖 **Histoire en cours** (${config.currentStory.words.length} mots, ${participants} participants)\n\n${story}`,
      ephemeral: true,
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot) return;
    if (!message.guildId) return;

    const config = this.getOrCreateConfig(message.guildId);

    if (!config.storyChannelId || message.channelId !== config.storyChannelId) {
      return;
    }

    if (!config.currentStory || !config.currentStory.isActive) {
      return;
    }

    const content = message.content.trim();
    
    // Vérifier si le message est vide
    if (!content) {
      await message.delete().catch(() => {});
      return;
    }
    
    // Vérifier si c'est un seul mot (peut contenir ponctuation)
    const words = content.split(/\s+/);
    
    if (words.length > 1) {
      await message.reply('❌ Tu ne peux envoyer qu\'**un seul mot** à la fois!');
      await message.delete().catch(() => {});
      return;
    }

    const word = words[0]!; // On sait que words[0] existe car content n'est pas vide
    const hasEndingPunctuation = word.endsWith('.') || word.endsWith('!') || word.endsWith('?');

    // Ajouter le mot à l'histoire
    config.currentStory.words.push({
      word: word,
      userId: message.author.id,
      timestamp: Date.now(),
    });

    // Réagir au message
    await message.react('✅').catch(() => {});

    // Si le mot se termine par un point, terminer l'histoire
    if (hasEndingPunctuation) {
      await this.completeStory(config);
    }
  }

  private async completeStory(config: GuildConfig) {
    if (!config.currentStory || config.currentStory.words.length === 0) return;

    const story = config.currentStory.words.map(w => w.word).join(' ');
    const participants = [...new Set(config.currentStory.words.map(w => w.userId))];
    const completedAt = new Date();

    // Sauvegarder l'histoire
    config.completedStories.push({
      content: story,
      completedAt,
      participants,
    });

    // Créer l'embed
    const embed = new EmbedBuilder()
      .setColor(0x808080) // Gris
      .setTitle('📖 Histoire Terminée')
      .setDescription(`\`\`\`${story}\`\`\``)
      .addFields(
        { name: '👥 Participants', value: `${participants.length} personnes`, inline: true },
        { name: '📝 Mots', value: `${config.currentStory.words.length}`, inline: true },
        { name: '🕐 Heure', value: `<t:${Math.floor(completedAt.getTime() / 1000)}:T>`, inline: true }
      )
      .setTimestamp(completedAt);

    // Envoyer l'embed
    const channel = await this.client.channels.fetch(config.storyChannelId!) as TextChannel;
    await channel.send({ embeds: [embed] });

    // Réinitialiser pour une nouvelle histoire
    config.currentStory = {
      channelId: config.storyChannelId!,
      words: [],
      isActive: true,
    };

    await channel.send('📖 **Nouvelle histoire!** C\'est reparti pour une nouvelle aventure collaborative!');
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

// Démarrage du bot
const bot = new StoryBot();
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant dans les variables d\'environnement');
  process.exit(1);
}

bot.start(TOKEN);
