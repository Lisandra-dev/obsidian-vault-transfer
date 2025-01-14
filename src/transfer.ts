import * as fs from "fs";
import { type App, type Editor, FileSystemAdapter, type MarkdownView, moment, normalizePath, Notice, TFile, type TFolder } from "obsidian";
import type { VaultTransferSettings } from "settings";
import { showNotice, TransferStatusBar } from "utils";
import type VaultTransferPlugin from "./main";

/**
 * Simple function that remove a part of a path using the settings "removePath"
 * @param settings {VaultTransferSettings} 
 * @param path {string}
 * @returns {string} The path without the parts to remove or the original path, depending on the settings
 */
function removePartOfPath(settings: VaultTransferSettings, path: string): string {
    for (const part of settings.removePath) {
        path = path.replace(RegExp(part, "gi"), "");
    }
    return normalizePath(path);
}

function replaceWithDate(path: string, date?: number | string) {
    if (!date) date = new Date().toISOString();
    const dateRegex = /\{\{(.*?)\}\}/gi;
    return path.replace(dateRegex, (_match: string, group: string) => {
        return moment(date).format(group);
    });
}

/** Regex-replace the path allowing for date variable */
export function overrideOutputPath(path: string, settings: VaultTransferSettings, metadate?: number | string) {
    const overridePath = settings.overridedPath;
    let overriddenPath = path;
    for (const override of overridePath) {
        const isRegex = override.sourcePath.match(/^\/(.*)\/[gimuy]*$/);
        const replacement = replaceWithDate(override.replacement, metadate);
        if (isRegex) {
            const regex = new RegExp(isRegex[1], isRegex[2]);
            if (regex.test(path)) {
                overriddenPath = overriddenPath.replace(regex, override.replacement);
            }
        } overriddenPath = overriddenPath.replace(override.sourcePath, replacement);
    }
    return normalizePath(overriddenPath);
}

/**
 * Copies the content of the current note to another vault, then replaces existing note contents with a link to the new file.
 */
export async function transferNote(editor: Editor | null, file: TFile | null, plugin: VaultTransferPlugin, recursive?: boolean, outputPath?: string, dataMetadata?: string | number) {
    const { app, settings } = plugin;
    try {
        // Check settings
        const settingsErrorShown = showErrorIfSettingsInvalid(settings);
        if (settingsErrorShown || !file) {
            return;
        }

        const outputVault = normalizePath(settings.outputVault);
        let outputFolder = normalizePath(settings.outputFolder);
        outputFolder = replaceWithDate(outputFolder, dataMetadata);

        // Get paths
        const fileSystemAdapter = app.vault.adapter;
        if (!(fileSystemAdapter instanceof FileSystemAdapter)) {
            showNotice("Error: fileSystemAdapter is not an instance of FileSystemAdapter");
            return;
        }

        const thisVaultPath = fileSystemAdapter.getBasePath();
        const fileName = file.name;
        const fileDisplayName = file.basename;
        let outputFolderPath: string;
        if (!outputPath) {
            outputFolderPath = `${outputVault}/${outputFolder}`;
            outputPath = normalizePath(`${outputFolderPath}/${fileName}`);
            if (settings.recreateTree) {
                outputPath = normalizePath(`${outputFolderPath}/${file.path}`);
                outputPath = removePartOfPath(settings, outputPath);
                outputPath = overrideOutputPath(outputPath, settings, dataMetadata);
            }
        } else {
            outputFolderPath = normalizePath(outputPath);
            outputPath = normalizePath(`${outputPath}/${fileName}`);
        }
        if (!recursive) showNotice(`Copying ${file.path} to ${outputPath}`);

        // Check if directory exists to avoid error when copying
        const folderExists = fs.existsSync(outputFolderPath);
        if (!folderExists && settings.automaticCreateOutputFolder) {
            // create folder if it doesn't exist
            fs.mkdirSync(normalizePath(outputFolderPath), { recursive: true });
        }
        else if (!folderExists) {
            showNotice(`Error: Directory does not exist at ${outputFolderPath}`);
            return;
        } else if (settings.recreateTree) {
            // create folder if it doesn't exist
            fs.mkdirSync(normalizePath(outputPath.replace(fileName, "")), { recursive: true });
        }

        if (fs.existsSync(outputPath)) {
            if (settings.overwrite) {
                fs.unlinkSync(outputPath);
            }
            else {
                showNotice("Error: File already exists");
                return;
            }
        }

        //get list of all attachments
        copyAllAttachments(file, plugin, outputPath, thisVaultPath);
        // Copy to new file in other vault
        fs.copyFileSync(normalizePath(`${thisVaultPath}/${file.path}`), outputPath);

        if (settings.createLink) {
            // Replace original file with link
            const link = createVaultFileLink(fileDisplayName, outputVault);
            if (editor) editor.setValue(link);
            else await app.vault.modify(file, link);
        } else if (settings.deleteOriginal && !recursive) {
            // Delete original file
            app.vault.trash(file, settings.moveToSystemTrash);
        }
    }
    catch (e) {
        showNotice("Error copying file", e);
    }
}

/**
 * Generate a list of all files in a folder (including subfolders)
 * @param file {TFolder} The folder to get files from
 * @returns {TFile[]} A list of all TFiles files in the folder
 */
function listToTransfer(folder: TFolder, app: App): TFile[] {
    const files = folder.children;
    const filesToTransfer: TFile[] = [];
    //recursive function to get all files in folder
    for (const file of files) {
        if (file instanceof TFile) {
            filesToTransfer.push(file as TFile);
        } else {
            filesToTransfer.push(...listToTransfer(file as TFolder, app));
        }
    }
    const folderParentNote = getFolderNote(folder, app);
    if (folderParentNote instanceof TFile) {
        //verify if not already in the list
        filesToTransfer.push(folderParentNote);
    }
    return filesToTransfer;
}

export function getFolderNote(folder: TFolder, app: App) {
    const parentFolder = folder.parent?.path ?? "/";
    const outsideFolderNote = app.vault.getAbstractFileByPath(normalizePath(`${parentFolder}/${folder.name}.md`));
    if (outsideFolderNote && outsideFolderNote instanceof TFile) {
        return outsideFolderNote;
    }
}

export function getMetadataDate(file: TFile | undefined | null, app: App, settings: VaultTransferSettings) {
    if (!file) return undefined;
    let metadataDate: undefined | number | string = undefined;
    if (settings.dateVariable.type === "frontmatter" && settings.dateVariable.frontmatterKey) {
        metadataDate = app.metadataCache.getFileCache(file)?.frontmatter?.[settings.dateVariable.frontmatterKey];
        if (!metadataDate) {
            if (settings.dateVariable.fallback === "creation") {
                return file.stat.ctime;
            } else if (settings.dateVariable.fallback === "modification") {
                return file.stat.mtime;
            }
        }
    } else if (settings.dateVariable.type === "creation") {
        return file.stat.ctime;
    } else if (settings.dateVariable.type === "modification") {
        return file.stat.mtime;
    }
    return metadataDate;
}

/**
 * Transfer a folder and all its contents to another vault
 * @param folder {TFolder} The folder to transfer
 * @param app {App} Obsidian app
 * @param settings {VaultTransferSettings} Plugin settings
 */
export function transferFolder(folder: TFolder, plugin: VaultTransferPlugin, outputPath?: string) {
    const { app, settings } = plugin;
    const files = listToTransfer(folder, app);
    let folderNote = getFolderNote(folder, app) ?? null;
    if (!folderNote) {
        //search file inside the folder with the same name as the folder
        const folderInsideNote = app.vault.getAbstractFileByPath(`${folder.path}/${folder.name}.md`);
        if (folderInsideNote instanceof TFile) {
            folderNote = folderInsideNote as TFile;
        } else {
            //maybe index ?
            const folderIndexNote = app.vault.getAbstractFileByPath(`${folder.path}/index.md`);
            if (folderIndexNote instanceof TFile) {
                folderNote = folderIndexNote as TFile;
            }
        }
    }
    const metadataDate = getMetadataDate(folderNote, app, settings);
    const noticeMessage: string[] = [];
    const statusBarItem = plugin.addStatusBarItem();
    const statusBar = new TransferStatusBar(statusBarItem, files.length);
    for (const file of files) {
        transferNote(null, file, plugin, true, outputPath, metadataDate);
        //delete folder after all files are transferred
        if (settings.deleteOriginal && !settings.createLink) {
            app.vault.trash(folder, settings.moveToSystemTrash);
        }
        statusBar.increment();
        noticeMessage.push(file.path);
    }
    new Notice(`Transfer completed. ${noticeMessage.length} files copied into ${outputPath ?? settings.outputFolder}. See logs for details!`);
    console.log(noticeMessage);
    statusBar.finish();
}

/**
 * Inserts a link at the cursor to the current file in another vault.
 */
export function insertLinkToOtherVault(editor: Editor, view: MarkdownView, settings: VaultTransferSettings) {
    // Check settings
    const settingsErrorShown = showErrorIfSettingsInvalid(settings);
    if (settingsErrorShown) {
        return;
    }

    if (view.file == null) {
        showNotice("Error: view.file is null");
        return;
    }

    // Get display name of current file
    const fileDisplayName = view.file?.basename;

    // Get output vault
    const outputVault = settings.outputVault;

    // Insert link to file
    const link = createVaultFileLink(fileDisplayName, outputVault);
    editor.replaceSelection(link);
}

/**
 * Creates a link to a file in another vault.
 */
function createVaultFileLink(fileDisplayName: string | undefined, outputVault: string): string {
    // Get content for link
    const vaultPathArray = normalizePath(outputVault).split("/");
    const vaultName = vaultPathArray[vaultPathArray.length - 1];
    const urlOtherVault = encodeURI(vaultName);
    const urlFile = encodeURI(fileDisplayName ?? "");

    return `[${fileDisplayName}](obsidian://vault/${urlOtherVault}/${urlFile})`;
}

/**
 * Ensures necessary info has been set in plugin settings, otherwise displays an error notice.
 * @returns True if an error was shown, otherwise false.
 */
function showErrorIfSettingsInvalid(settings: VaultTransferSettings): boolean {
    const message: string | null = settings.outputVault.trim().length == 0 ? "Target vault has not been set." : null;

    // Show notice, if necessary
    if (message != null) {
        showNotice(`Error: ${message}`);
        return true;
    }

    return false;
}

/**
 * Copy all attachments of a file to a new vault -- Respecting the folder structure of the attachments
 * @param file {TFile} The file to copy the attachments from
 * @param app {App} Obsidian app
 * @param newVault {string} The path of the new vault, where the attachments should be copied to. 
 * @param thisVaultPath {string} The path of the current vault, where the attachments are located.
 */
function copyAllAttachments(file: TFile, plugin: VaultTransferPlugin, newVault: string, thisVaultPath: string) {
    const { app } = plugin;

    //Get all attachments of the file, aka embedded things (pdf, image...)
    const attachments = app.metadataCache.getFileCache(file)?.embeds ?? [];
    if (attachments.length === 0) return;
    const statusBarItem = plugin.addStatusBarItem();
    const statusBar = new TransferStatusBar(statusBarItem, attachments.length, true);
    for (const attachment of attachments) {
        //copy the attachment to the new vault
        const attachmentPath = app.metadataCache.getFirstLinkpathDest(attachment.link.replace(/#.*/, ""), file.path);
        if (attachmentPath) {
            //recreate the path of the attachment in the new vault
            const newAttachmentPath = normalizePath(`${newVault.replace(file.name, "")}/${attachmentPath.path}`);
            const oldAttachmentPath = normalizePath(`${thisVaultPath}/${attachmentPath.path}`);
            //check if the folder exists, if not create it
            if (!fs.existsSync(newAttachmentPath.replace(attachmentPath.name, ""))) {
                //recursively create the folder
                fs.mkdirSync(newAttachmentPath.replace(attachmentPath.name, ""), { recursive: true });
            }
            //copy the attachment
            fs.copyFileSync(oldAttachmentPath, newAttachmentPath);
            statusBar.increment();
        }
    }
    statusBar.finish();
}