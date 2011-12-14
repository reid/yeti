all: install

test:
	npm test

install-stable:
	npm install yeti

install:
	npm -g install .

remove:
	npm -g uninstall yeti

.PHONY: all install-stable install remove test
