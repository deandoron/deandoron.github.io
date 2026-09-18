var pages = {
	home: 'home.html',
	papers: 'papers.html',
	teaching: 'teaching.html',
	students: 'students.html',
	derand: 'derand.html',
	contact: 'contact.html'
};

$(document).ready(init);

function init() {
	initNavigation();
	initImg();
}

function initNavigation() {
	$(window).on('hashchange', loadPage);
	loadPage();
}

function loadPage() {
	var page = window.location.hash.substring(1).toLowerCase();
	$('#main-content').load(pages[page] || pages.home);
}

function initImg() {
	var img1 = 'dean.jpg';
	var img2 = 'jump.jpg';
	var img3 = 'panda1.jpg';
	// attach event to 'body' because elements inside it might change dynamically
	// the selector '#home-img' filters other elements from triggering the event
	$('body').on('dblclick', '#home-img', function(){
		var element = $('#home-img');
		var src = element.attr('src');
		switch(src) {
		  case img1:
		    element.attr('src', img2);
		    break;
		  case img2:
		    element.attr('src', img3);
		    break;
		  case img3:
		    element.attr('src', img1);
		    break;
		  default:
		    break;
		}
	});
}
