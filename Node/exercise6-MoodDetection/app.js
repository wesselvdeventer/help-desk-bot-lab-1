/* jshint esversion: 6 */
const restify = require('restify');
const builder = require('botbuilder');
const ticketsApi = require('./ticketsApi');
const azureSearch = require('./azureSearchApiClient');
const textAnalytics = require('./textAnalyticsApiClient');

const azureSearchQuery = azureSearch({
    searchName: process.env.AZURE_SEARCH_ACCOUNT || 'bot-framework-trainer',
    indexName: process.env.AZURE_SEARCH_INDEX || 'faq-index',
    searchKey: process.env.AZURE_SEARCH_KEY || '79CF1B7A94947547A2E7C65E3532888C'
});

const analyzeText = textAnalytics({
    apiKey: process.env.TEXT_ANALYTICS_KEY || '818d86baf22547eb8193aa150fdfb5bd'
});

const listenPort = process.env.port || process.env.PORT || 3978;

// Setup Restify Server
const server = restify.createServer();
server.listen(listenPort, () => {
    console.log('%s listening to %s', server.name, server.url);
});

// Setup body parser and sample tickets api
server.use(restify.bodyParser());
server.post('/api/tickets', ticketsApi);

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

// Listen for messages from users
server.post('/api/messages', connector.listen());

const luisModelUrl = process.env.LUIS_MODEL_URL || 'https://westus.api.cognitive.microsoft.com/luis/v2.0/apps/c7637a36-6a94-4c15-9943-c25463eb3db6?subscription-key=cbb127d36fc0474c9f9222cf070c44cc&verbose=true&timezoneOffset=0&q=';

var bot = new builder.UniversalBot(connector, (session) => {
    session.sendTyping();
    azureSearchQuery(`search=${encodeURIComponent(session.message.text)}`, (err, result) => {
        if (err) {
            session.send('Ooops! Something went wrong on my side, please try again later.');
            return;
        }
        session.replaceDialog('ShowKBResults', { result, originalText: session.message.text });
    });
});

bot.recognizer(new builder.LuisRecognizer(luisModelUrl));

bot.dialog('SubmitTicket', [
    (session, args, next) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');
        var severity = builder.EntityRecognizer.findEntity(args.intent.entities, 'severity');

        if (category && category.resolution.values.length > 0) {
            session.dialogData.category = category.resolution.values[0];
        }

        if (severity && severity.resolution.values.length > 0) {
            session.dialogData.severity = severity.resolution.values[0];
        }

        session.dialogData.description = session.message.text;

        if (!session.dialogData.severity) {
            var choices = ['high', 'normal', 'low'];
            builder.Prompts.choice(session, 'Which is the severity of this problem?', choices);
        } else {
            next();
        }
    },
    (session, result, next) => {
        if (!session.dialogData.severity) {
            session.dialogData.severity = result.response.entity;
        }

        if (!session.dialogData.category) {
            builder.Prompts.text(session, 'Which would be the category for this ticket (software, hardware, network, and so on)?');
        } else {
            next();
        }
    },
    (session, result, next) => {
        if (!session.dialogData.category) {
            session.dialogData.category = result.response;
        }

        var message = `Great! I'm going to create a **${session.dialogData.severity}** severity ticket in the **${session.dialogData.category}** category. ` +
                      `The description I will use is _"${session.dialogData.description}"_. Can you please confirm that this information is correct?`;

        builder.Prompts.confirm(session, message);
    },
    (session, result, next) => {
        if (result.response) {
            var data = {
                category: session.dialogData.category,
                severity: session.dialogData.severity,
                description: session.dialogData.description,
            }

            const client = restify.createJsonClient({ url: `http://localhost:${listenPort}` });

            client.post('/api/tickets', data, (err, request, response, ticketId) => {
                if (err || ticketId == -1) {
                    session.send('Ooops! Something went wrong while I was saving your ticket. Please try again later.')
                } else {
                    session.send(`Awesome! Your ticked has been created with the number ${ticketId}.`);
                }

                session.replaceDialog('UserFeedbackRequest');
            });
        } else {
            session.endDialog('Ok. The ticket was not created. You can start again if you want.');
        }
    }
]).triggerAction({
    matches: 'SubmitTicket'
});

bot.dialog('ExploreKnowledgeBase', [
    (session, args) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');

        if (!category) {
            // retrieve facets
            azureSearchQuery('facet=category', (error, result) => {
                if (error) {
                    session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                } else {
                    var choices = result['@search.facets'].category.map(item=> `${item.value} (${item.count})`);
                    builder.Prompts.choice(session, 'Which category are you interested in?', choices);
                }
            });
        } else {
            // search by category
            azureSearchQuery('$filter=' + encodeURIComponent(`category eq '${category.entity}'`), (error, result) => {
                if (error) {
                    session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                } else {
                    session.replaceDialog('ShowKBResults', { result, originalText: session.message.text });
                }
            });
        }
    },
    (session, args) => {
        var category = args.response.entity.replace(/\s\([^)]*\)/,'');
        // search by category
        azureSearchQuery('$filter=' + encodeURIComponent(`category eq '${category}'`), (error, result) => {
            if (error) {
                session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
            } else {
                session.replaceDialog('ShowKBResults', { result, originalText: category });
            }
        });
    }
]).triggerAction({
    matches: 'ExploreKnowledgeBase'
});

bot.dialog('DetailsOf', [
    (session, args) => {
        var title = session.message.text.substring('show me the article '.length);
        azureSearchQuery('$filter=' + encodeURIComponent(`title eq '${title}'`), (error, result) => {
            if (error || !result.value[0]) {
                session.endDialog('Sorry, I could not find that article.');
            } else {
                session.endDialog(result.value[0].text);
            }
        });
    }
]).triggerAction({
    matches: /^show me the article (.*)/
});

bot.dialog('ShowKBResults', [
    (session, args) => {
        if (args.result.value.length > 0) {
            var msg = new builder.Message(session).attachmentLayout(builder.AttachmentLayout.carousel);
            args.result.value.forEach((faq, i) => {
                msg.addAttachment(
                    new builder.HeroCard(session)
                        .title(faq.title)
                        .subtitle(`Category: ${faq.category} | Search Score: ${faq['@search.score']}`)
                        .text(faq.text.substring(0, Math.min(faq.text.length, 50) + '...'))
                        .buttons([{ title: 'More details', value: `show me the article ${faq.title}`, type: 'postBack' }])
                );
            });
            session.send(`These are some articles I\'ve found in the knowledge base for _'${args.originalText}'_, click **More details** to read the full article:`);
            session.endDialog(msg);
        } else {
            session.endDialog(`Sorry, I could not find any results in the knowledge base for _'${args.originalText}'_`);
        }
    }
]);

bot.dialog('UserFeedbackRequest', [
    (session, args) => {
        builder.Prompts.text(session, 'How would you rate my help?');
    },
    (session, response) => {
        const answer = session.message.text;
        analyzeText(answer, (err, score) => {
            if (err) {
                session.endDialog('Ooops! Something went wrong while analying your answer. An IT representative agent will get in touch with you to follow up soon.');
            } else {
                // 1 - positive feeling / 0 - negative feeling
                if (score < 0.5) {
                    session.endDialog('I understand that you might be dissatisfied with my assistance. An IT representative will get in touch with you soon to help you.');
                } else {
                    session.endDialog('Thanks for sharing your experience.');
                }
            }
        });
    }
]);