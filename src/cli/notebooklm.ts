import chalk from 'chalk';
import { Command } from 'commander';
import { NotebookLMClient } from '../notebooklm/client.js';

async function withClient<T>(fn: (client: NotebookLMClient) => Promise<T>): Promise<T> {
  const client = await NotebookLMClient.fromStorage();
  await client.open();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export function createNotebookLMCommand(): Command {
  const cmd = new Command('notebooklm')
    .description('Manage NotebookLM notebooks and sources')
    .alias('nb');

  // ── list ──────────────────────────────────────────────
  cmd
    .command('list')
    .alias('ls')
    .description('List all notebooks')
    .action(async () => {
      await withClient(async (client) => {
        const notebooks = await client.notebooks.list();

        if (notebooks.length === 0) {
          console.log(chalk.dim('No notebooks found.'));
          return;
        }

        console.log(chalk.bold(`Notebooks (${notebooks.length})\n`));
        for (const nb of notebooks) {
          const date = nb.createdAt ? chalk.dim(nb.createdAt.toLocaleDateString()) : '';
          console.log(`  ${chalk.cyan(nb.id)}  ${nb.title || chalk.dim('(untitled)')}  ${date}`);
        }
      });
    });

  // ── create ────────────────────────────────────────────
  cmd
    .command('create <title>')
    .description('Create a new notebook')
    .action(async (title: string) => {
      await withClient(async (client) => {
        const nb = await client.notebooks.create(title);
        console.log(chalk.green(`✓ Created notebook: ${nb.title}`));
        console.log(chalk.dim(`  ID: ${nb.id}`));
      });
    });

  // ── delete ────────────────────────────────────────────
  cmd
    .command('delete <notebookId>')
    .alias('rm')
    .description('Delete a notebook')
    .action(async (notebookId: string) => {
      await withClient(async (client) => {
        await client.notebooks.delete(notebookId);
        console.log(chalk.green(`✓ Deleted notebook ${notebookId}`));
      });
    });

  // ── sources ───────────────────────────────────────────
  cmd
    .command('sources <notebookId>')
    .description('List sources in a notebook')
    .action(async (notebookId: string) => {
      await withClient(async (client) => {
        const sources = await client.sources.list(notebookId);

        if (sources.length === 0) {
          console.log(chalk.dim('No sources found.'));
          return;
        }

        console.log(chalk.bold(`Sources (${sources.length})\n`));
        for (const src of sources) {
          const status = src.isReady
            ? chalk.green('ready')
            : src.isProcessing
              ? chalk.yellow('processing')
              : chalk.red('error');
          const urlPart = src.url ? chalk.dim(` ${src.url}`) : '';
          console.log(
            `  ${chalk.cyan(src.id)}  ${src.title || chalk.dim('(untitled)')}  [${src.kind}]  ${status}${urlPart}`,
          );
        }
      });
    });

  // ── add-url ───────────────────────────────────────────
  cmd
    .command('add-url <notebookId> <url>')
    .description('Add a URL source to a notebook')
    .option('--wait', 'Wait for source to be processed', false)
    .action(async (notebookId: string, url: string, opts: { wait: boolean }) => {
      await withClient(async (client) => {
        console.log(chalk.dim(`Adding URL: ${url}`));
        const source = await client.sources.addUrl(notebookId, url, opts.wait);
        console.log(chalk.green(`✓ Added source: ${source.title || source.id} [${source.kind}]`));
        if (!source.isReady) {
          console.log(chalk.yellow('  Source is still processing. Use --wait to wait for it.'));
        }
      });
    });

  // ── add-file ──────────────────────────────────────────
  cmd
    .command('add-file <notebookId> <filePath>')
    .description('Upload a file source to a notebook (PDF, DOCX, TXT, etc.)')
    .option('--wait', 'Wait for source to be processed', false)
    .action(async (notebookId: string, filePath: string, opts: { wait: boolean }) => {
      await withClient(async (client) => {
        console.log(chalk.dim(`Uploading: ${filePath}`));
        const source = await client.sources.addFile(notebookId, filePath, undefined, opts.wait);
        console.log(
          chalk.green(`✓ Uploaded source: ${source.title || source.id} [${source.kind}]`),
        );
        if (!source.isReady) {
          console.log(chalk.yellow('  Source is still processing. Use --wait to wait for it.'));
        }
      });
    });

  // ── add-text ──────────────────────────────────────────
  cmd
    .command('add-text <notebookId> <title> <content>')
    .description('Add pasted text as a source')
    .option('--wait', 'Wait for source to be processed', false)
    .action(async (notebookId: string, title: string, content: string, opts: { wait: boolean }) => {
      await withClient(async (client) => {
        const source = await client.sources.addText(notebookId, title, content, opts.wait);
        console.log(
          chalk.green(`✓ Added text source: ${source.title || source.id} [${source.kind}]`),
        );
      });
    });

  // ── summarize ─────────────────────────────────────────
  cmd
    .command('summarize <notebookId>')
    .description('Get AI summary and suggested topics for a notebook')
    .action(async (notebookId: string) => {
      await withClient(async (client) => {
        const desc = await client.notebooks.getDescription(notebookId);
        if (desc.summary) {
          console.log(chalk.bold('Summary\n'));
          console.log(`  ${desc.summary}\n`);
        }
        if (desc.suggestedTopics.length > 0) {
          console.log(chalk.bold('Suggested Topics\n'));
          for (const topic of desc.suggestedTopics) {
            console.log(`  ${chalk.cyan('•')} ${topic.question}`);
          }
        }
      });
    });

  return cmd;
}
