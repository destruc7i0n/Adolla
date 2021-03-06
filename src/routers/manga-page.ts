
import express from "express";
const router = express.Router();

import db from "../db";
import updateManga from "../util/updateManga";
import Mangasee from "../scrapers/mangasee";
import { Progress, StoredData, List } from "../types";
import getMangaProgress, { setMangaProgress } from "../util/getMangaProgress";
import getReading from "../util/getReading";
import { getLists } from "../util/lists";

interface NewList {
	slug: string;
	name: string;
}

router.get("/:slug", async (req, res, next) => {

	let param = req.params.slug;

	let data = await updateManga(param, true);

	if(data && data.success) {

		// See if chapter is same as "last read" chapter
		await setColors(data, param);

		// Set progress
		await setMangaProgress(data);

		// Get reading
		let reading = await getReading(4);

		// Get lists for manga
		let allLists = await getLists();
		let lists = allLists.filter(l => l.entries.find(m => m.slug === param));

		const convert = ((l: List) => ({
			slug: l.slug,
			name: l.name
		}));

		res.render("manga", {
			data,
			reading,
			currentSlug: param,
			lists: lists.filter(l => !l.byCreator).map(convert),
			allLists: allLists.filter(l => !l.byCreator).map(convert)
		});
	} else {
		console.error("No data found for", param);
		next();
	}
});

router.get("/:slug/:chapter", async (req, res, next) => {
	let chapterIndicator = req.params.chapter;
	let slug = req.params.slug;
	
	let chapterMatch = chapterIndicator.match(/(\d*\.?\d+)-(\d*\.?\d+)/);
	if(!chapterMatch) {
		next();
		return;
	}

	let [_null, season, chapter]: number[] = chapterMatch.map(v => Number(v)); // Bit of a hack...

	let data = await updateManga(slug, true);

	if(data && data.success) {

		// Stuff
		let manga = await Mangasee.scrape(slug, chapter, season);
		manga = await setMangaProgress(manga);

		if(!manga.success) {
			next();
			return;
		}

		// Find current, last, and next chapter
		let chapters = manga.data.chapters;
		let currentChapter = chapters.find(c => c.season === season && c.chapter === chapter);
		let nextChapter = chapters[chapters.indexOf(currentChapter) + 1] ?? null;
		let previousChapter = chapters[chapters.indexOf(currentChapter) - 1] ?? null;

		// Add progress from `data` chapters to `manga` chapters
		for(let i = 0; i < data.data.chapters.length; i++) {
			manga.data.chapters[i].progress = data.data.chapters[i].progress;
		}

		// See if chapter is same as last chapter
		await setColors(manga, slug);

		// Get reading
		let reading = await getReading(4);

		res.render("manga-chapter", {
			data: manga,
			navigation: {
				nextChapter,
				previousChapter,
				currentChapter
			},
			readerSettings: true,
			currentSlug: slug,
			reading
		});
	} else {
		console.error("No data found for", slug);
		next();
	}

});

router.post("/:slug/set-lists", async (req, res) => {

	let newLists: NewList[] = req.body.lists;

	let currentLists: List[] = await getLists();

	for(let n of newLists) {
		// Verify existing list
		if(!currentLists.find(l => l.slug === n.slug)) {
			// Add new list
			currentLists.push({
				slug: n.slug,
				name: n.name,
				entries: [],
				showOnHome: false
			});
		}

		// Add to list
		let list = currentLists.find(l => l.slug === n.slug);
		if(!list.entries.find(entry => entry.slug === req.params.slug) && !list.byCreator) {
			list.entries.push({
				slug: req.params.slug
			});
			list.last = Date.now();
		}

	}

	// Remove from other list
	let otherLists = currentLists.filter(l => !newLists.find(newList => newList.slug === l.slug) && !l.byCreator);
	for(let deleteFrom of otherLists) {
		// Remove every entry from this list since it wasn't mentioned in the updated list
		while(deleteFrom.entries.find(v => v.slug === req.params.slug)) {
			deleteFrom.entries.splice(deleteFrom.entries.indexOf(deleteFrom.entries.find(v => v.slug === req.params.slug)), 1);
			deleteFrom.last = Date.now();
		}
	}

	// Remove empty lists
	currentLists = currentLists.filter(list => list.entries.length > 0);

	// Sort lists
	currentLists = currentLists.sort((a, b) => (b.last ?? -1) - (a.last ?? -1));
	
	// Store new value
	db.set("lists", currentLists.filter(l => !l.byCreator));

	res.json({
		status: 200
	});
});

router.post("/:slug/:chapter/set-progress", async (req, res, next) => {
	let chapterIndicator = req.params.chapter;
	let slug = req.params.slug;
	
	let chapterMatch = chapterIndicator.match(/(\d*\.?\d+)-(\d*\.?\d+)/);
	if(!chapterMatch) {
		next();
		return;
	}

	let [_null, season, chapter]: number[] = chapterMatch.map(v => Number(v)); // Bit of a hack...

	if(!req.body.current || !req.body.total) {
		res.status(403);
		res.json({
			status: 401,
			err: "Missing current or total"
		});
		return;
	}

	let progressData = {
		current: req.body.current,
		total: req.body.total,
		percentage: Math.round((req.body.current / req.body.total) * 100),
		at: Date.now(),
		season,
		chapter	
	};

	// Update db
	db.set(`reading.${slug}.${season}-${chapter.toString().replace(/\./g, "_")}`, progressData);
	db.set(`reading.${slug}.last`, progressData);

	res.json({
		status: 200
	});
});

export default router;

async function setColors(data: StoredData, slug: string) {
	let lastChapter: Progress = await getMangaProgress(slug);
	data.data.chapters.forEach(ch => {
		if(ch.progress) ch.progress.percentageColor = (ch.progress && ch.progress.season === lastChapter.season && ch.progress.chapter === lastChapter.chapter) ? "recent" : "neutral";
	});
}