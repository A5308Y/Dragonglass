port module Brainstorm exposing (main)

import Browser
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.Brainstorm as Command exposing (Command)
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Host as Host exposing (RequestId, Requests)
import Gtd.Id exposing (ActionId)
import Gtd.Ui as Ui
import Html exposing (Html, button, div, h2, h3, h4, header, img, input, label, li, p, section, small, span, text, textarea, ul)
import Html.Attributes exposing (alt, attribute, autofocus, class, classList, disabled, for, id, placeholder, src, title, value)
import Html.Events exposing (on, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Time


port brainstormToHost : Encode.Value -> Cmd msg


port brainstormFromHost : (Decode.Value -> msg) -> Sub msg


{-| Five minutes is the whole point of the exercise: long enough to get past the
obvious answers, short enough to stay divergent.
-}
sessionSeconds : Int
sessionSeconds =
    300


{-| What is being brainstormed. A topic session remembers the Action it suspended,
so abandoning the topic returns to exactly where the session started.
-}
type Session
    = TaskSession ActionId
    | TopicSession { topic : String, resume : Maybe ActionId }


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | ApplyWords
    | FinishSave
      -- The partner's answer, for the partner generation that asked.
    | PartnerReply Int


{-| The local model as a brainstorming partner (see `src/domain/brainstorm-partner.ts`).
It is asked when the person pauses after writing something new, and at least every
`partnerEvery` seconds, while the five minutes run. What it offers waits beside the
ideas until it is added or dismissed; only what is added is saved.
-}
type alias Partner =
    { on : Bool
    , asking : Bool

    -- Bumped when the session changes or the partner stops, so a late answer is dropped.
    , generation : Int
    , ideas : List String
    , considerations : List String

    -- Everything offered this session, so it isn't offered again.
    , offered : List String

    -- The ideas as they were when last asked.
    , askedWith : String
    , sinceReply : Int
    , quietFor : Int
    , problem : Maybe String
    }


idlePartner : Int -> Partner
idlePartner generation =
    { on = False
    , asking = False
    , generation = generation
    , ideas = []
    , considerations = []
    , offered = []
    , askedWith = ""
    , sinceReply = 0
    , quietFor = 0
    , problem = Nothing
    }


{-| Seconds of calm after writing before the partner is asked again.
-}
partnerPause : Int
partnerPause =
    4


{-| The fewest seconds between answers, and the most while nothing new is written.
-}
partnerSoonest : Int
partnerSoonest =
    15


partnerEvery : Int
partnerEvery =
    45


{-| What Shuffle or Change topic set aside, so one slip does not cost a session.
-}
type alias SetAside =
    { session : Maybe Session
    , topicDraft : String
    , desiredOutcome : String
    , ideas : String
    , seconds : Int
    }


type alias Model =
    { snapshot : Snapshot
    , session : Maybe Session
    , setAside : Maybe SetAside
    , topicDraft : String
    , desiredOutcome : String
    , ideas : String
    , words : List String
    , seconds : Int
    , selectionStart : Int
    , selectionEnd : Int
    , requests : Requests Pending
    , saving : Bool
    , error : Maybe String

    -- The tab was closed: timers off (see `Host.isClosing`).
    , closed : Bool
    , partnerAvailable : Bool
    , partner : Partner

    -- Images from the inspiration folder, one shown at a time and cycled every three minutes.
    , inspirations : List String
    , inspiration : Int
    , inspirationShown : Int
    }


type Msg
    = GotHost Decode.Value
    | Tick Time.Posix
    | TopicChanged String
    | StartTopic
    | AbandonTopic
    | ShuffleTask
    | ShufflePrompts
    | RestoreSetAside
    | DismissSetAside
    | OutcomeChanged String
    | IdeasChanged String
    | IdeasSelected Int Int
    | InsertWord String
    | Save
    | StartPartner
    | StopPartner
    | AskPartner
    | AddSuggestion String
    | DismissSuggestion String
    | NextInspiration
    | Send Pending Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions =
            \model ->
                if model.closed then
                    Sub.none

                else
                    Sub.batch [ brainstormFromHost GotHost, Time.every 1000 Tick ]
        , view = view
        }


type alias Flags =
    { snapshot : Snapshot, words : List String, randomIndex : Int, partner : Bool, inspirations : List String }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            let
                available =
                    candidates decoded.snapshot

                session =
                    if List.isEmpty available then
                        Nothing

                    else
                        itemAt (modBy (List.length available) decoded.randomIndex) available
                            |> Maybe.map (.id >> TaskSession)
            in
            loadOutcome
                (emptyModel decoded.snapshot decoded.words session
                    |> (\model ->
                            { model
                                | partnerAvailable = decoded.partner
                                , inspirations = decoded.inspirations

                                -- A different image to start with each time the view opens.
                                , inspiration = modBy (max 1 (List.length decoded.inspirations)) decoded.randomIndex
                            }
                       )
                )

        Err error ->
            ( { blankModel | error = Just (Decode.errorToString error) }, Cmd.none )


emptyModel : Snapshot -> List String -> Maybe Session -> Model
emptyModel snapshot words session =
    { snapshot = snapshot
    , session = session
    , setAside = Nothing
    , topicDraft = ""
    , desiredOutcome = ""
    , ideas = ""
    , words = words
    , seconds = sessionSeconds
    , selectionStart = 0
    , selectionEnd = 0
    , requests = Host.noRequests
    , saving = False
    , error = Nothing
    , closed = False
    , partnerAvailable = False
    , partner = idlePartner 0
    , inspirations = []
    , inspiration = 0
    , inspirationShown = 0
    }


blankModel : Model
blankModel =
    emptyModel Data.empty [] Nothing


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            if Host.isClosing value then
                ( { model | closed = True }, Cmd.none )

            else
                receiveHost value model

        Tick _ ->
            if model.session == Nothing then
                ( model, Cmd.none )

            else
                partnerTick (inspirationTick { model | seconds = max 0 (model.seconds - 1) })

        TopicChanged topic ->
            ( { model | topicDraft = topic }, Cmd.none )

        StartTopic ->
            if String.isEmpty (String.trim model.topicDraft) then
                ( model, Cmd.none )

            else
                newSession
                    { model
                        | session =
                            Just
                                (TopicSession
                                    { topic = String.trim model.topicDraft
                                    , resume = Maybe.map .id (currentAction model)
                                    }
                                )
                    }

        AbandonTopic ->
            let
                resumed =
                    case model.session of
                        Just (TopicSession fields) ->
                            fields.resume
                                |> Maybe.andThen (\actionId -> Data.findAction actionId (candidates model.snapshot))
                                |> Maybe.map .id

                        _ ->
                            Nothing
            in
            ( { model
                | session = Maybe.map TaskSession resumed
                , partner = idlePartner (model.partner.generation + 1)
                , setAside = setAside model
                , topicDraft = ""
                , ideas = ""
                , desiredOutcome = ""
                , seconds = sessionSeconds
              }
            , Cmd.none
            )

        ShuffleTask ->
            let
                available =
                    candidates model.snapshot

                position =
                    currentAction model
                        |> Maybe.andThen (\action -> indexOf action.id available)
                        |> Maybe.withDefault -1

                next =
                    itemAt (modBy (max 1 (List.length available)) (position + 1)) available
            in
            newSession { model | session = Maybe.map (.id >> TaskSession) next, setAside = setAside model }

        RestoreSetAside ->
            case model.setAside of
                Just saved ->
                    ( { model
                        | session = saved.session
                        , topicDraft = saved.topicDraft
                        , desiredOutcome = saved.desiredOutcome
                        , ideas = saved.ideas
                        , seconds = saved.seconds
                        , selectionStart = String.length saved.ideas
                        , selectionEnd = String.length saved.ideas
                        , setAside = Nothing
                      }
                    , Cmd.none
                    )

                Nothing ->
                    ( model, Cmd.none )

        DismissSetAside ->
            ( { model | setAside = Nothing }, Cmd.none )

        ShufflePrompts ->
            send ApplyWords Command.ShuffleBrainstormWords model

        OutcomeChanged outcome ->
            ( { model | desiredOutcome = outcome }, Cmd.none )

        IdeasChanged ideas ->
            let
                partner =
                    model.partner
            in
            ( { model
                | ideas = ideas
                , selectionStart = String.length ideas
                , selectionEnd = String.length ideas
                , partner = { partner | quietFor = 0 }
              }
            , Cmd.none
            )

        IdeasSelected start end ->
            ( { model | selectionStart = start, selectionEnd = end }, Cmd.none )

        InsertWord word ->
            insertWord word model

        Save ->
            save model

        StartPartner ->
            let
                partner =
                    model.partner
            in
            askPartner { model | partner = { partner | on = True, problem = Nothing } }

        StopPartner ->
            let
                partner =
                    model.partner
            in
            -- What it offered stays to be added; a question still out is dropped.
            ( { model | partner = { partner | on = False, asking = False, generation = partner.generation + 1 } }, Cmd.none )

        AskPartner ->
            askPartner model

        AddSuggestion suggestion ->
            let
                partner =
                    model.partner

                separator =
                    if String.isEmpty model.ideas || String.endsWith "\n" model.ideas then
                        ""

                    else
                        "\n"

                ideas =
                    model.ideas ++ separator ++ suggestion
            in
            ( { model
                | ideas = ideas
                , selectionStart = String.length ideas
                , selectionEnd = String.length ideas
                , partner = withoutSuggestion suggestion partner
              }
            , Cmd.none
            )

        DismissSuggestion suggestion ->
            ( { model | partner = withoutSuggestion suggestion model.partner }, Cmd.none )

        NextInspiration ->
            ( { model | inspiration = model.inspiration + 1, inspirationShown = 0 }, Cmd.none )

        Send pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


insertWord : String -> Model -> ( Model, Cmd Msg )
insertWord word model =
    let
        start =
            clamp 0 (String.length model.ideas) model.selectionStart

        end =
            clamp start (String.length model.ideas) model.selectionEnd

        before =
            String.left start model.ideas

        after =
            String.dropLeft end model.ideas

        prefix =
            if String.isEmpty before || String.endsWith " " before || String.endsWith "\n" before then
                ""

            else
                " "

        suffix =
            if String.isEmpty after || String.startsWith " " after || String.startsWith "\n" after then
                ""

            else
                " "

        insertion =
            prefix ++ word ++ suffix

        cursor =
            start + String.length insertion
    in
    send IgnoreReply
        (Command.FocusBrainstormIdeas cursor cursor)
        { model | ideas = before ++ insertion ++ after, selectionStart = cursor, selectionEnd = cursor }


inspirationTick : Model -> Model
inspirationTick model =
    if model.inspirationShown + 1 >= inspirationSeconds then
        { model | inspiration = model.inspiration + 1, inspirationShown = 0 }

    else
        { model | inspirationShown = model.inspirationShown + 1 }


currentInspiration : Model -> Maybe String
currentInspiration model =
    case model.inspirations of
        [] ->
            Nothing

        images ->
            itemAt (modBy (List.length images) model.inspiration) images


partnerTick : Model -> ( Model, Cmd Msg )
partnerTick model =
    let
        partner =
            model.partner

        counted =
            { partner | sinceReply = partner.sinceReply + 1, quietFor = partner.quietFor + 1 }

        wroteSince =
            model.ideas /= partner.askedWith

        due =
            (wroteSince && counted.sinceReply >= partnerSoonest && counted.quietFor >= partnerPause)
                || counted.sinceReply >= partnerEvery
    in
    if not partner.on || partner.asking then
        ( model, Cmd.none )

    else if due && model.seconds > 0 then
        askPartner { model | partner = counted }

    else
        ( { model | partner = counted }, Cmd.none )


askPartner : Model -> ( Model, Cmd Msg )
askPartner model =
    let
        partner =
            model.partner
    in
    if partner.asking || model.session == Nothing then
        ( model, Cmd.none )

    else
        send (PartnerReply partner.generation)
            (Command.SuggestIdeas
                { topic = sessionTopic model
                , desiredOutcome = model.desiredOutcome
                , ideas = model.ideas
                , offered = partner.offered
                }
            )
            { model | partner = { partner | asking = True, askedWith = model.ideas } }


withoutSuggestion : String -> Partner -> Partner
withoutSuggestion suggestion partner =
    { partner
        | ideas = List.filter ((/=) suggestion) partner.ideas
        , considerations = List.filter ((/=) suggestion) partner.considerations
    }


{-| How long one inspiration image stays before the next.
-}
inspirationSeconds : Int
inspirationSeconds =
    180


{-| What the session is about, as the partner is told.
-}
sessionTopic : Model -> String
sessionTopic model =
    case model.session of
        Just (TopicSession fields) ->
            fields.topic

        Just (TaskSession _) ->
            currentAction model |> Maybe.map .title |> Maybe.withDefault ""

        Nothing ->
            ""


save : Model -> ( Model, Cmd Msg )
save model =
    if String.isEmpty (String.trim model.ideas) then
        ( model, Cmd.none )

    else
        case model.session of
            Just (TopicSession fields) ->
                send FinishSave (Command.SaveStandaloneBrainstorm fields.topic model.ideas) { model | saving = True }

            Just (TaskSession _) ->
                case currentAction model of
                    Just action ->
                        send FinishSave
                            (Command.SaveBrainstorm action.id
                                model.ideas
                                (Maybe.map (always model.desiredOutcome) (currentProject model))
                            )
                            { model | saving = True }

                    Nothing ->
                        ( model, Cmd.none )

            Nothing ->
                ( model, Cmd.none )


{-| The work Shuffle or Change topic is about to clear, when there is any.
-}
setAside : Model -> Maybe SetAside
setAside model =
    if String.isEmpty (String.trim model.ideas) && String.isEmpty (String.trim model.desiredOutcome) then
        model.setAside

    else
        Just
            { session = model.session
            , topicDraft = model.topicDraft
            , desiredOutcome = model.desiredOutcome
            , ideas = model.ideas
            , seconds = model.seconds
            }


newSession : Model -> ( Model, Cmd Msg )
newSession model =
    let
        reset =
            { model
                | desiredOutcome = ""
                , ideas = ""
                , seconds = sessionSeconds
                , selectionStart = 0
                , selectionEnd = 0
                , error = Nothing
                , partner = idlePartner (model.partner.generation + 1)
            }

        ( shuffled, shuffleCmd ) =
            send ApplyWords Command.ShuffleBrainstormWords reset

        ( loaded, outcomeCmd ) =
            loadOutcome shuffled
    in
    ( loaded, Cmd.batch [ shuffleCmd, outcomeCmd ] )


loadOutcome : Model -> ( Model, Cmd Msg )
loadOutcome model =
    case currentProject model of
        Just project ->
            send IgnoreReply (Command.LoadBrainstormOutcome project.id) model

        Nothing ->
            ( model, Cmd.none )


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests, saving = hasSavingRequest requests }
    , brainstormToHost (Host.envelope requestId (Command.encode command))
    )


hasSavingRequest : Requests Pending -> Bool
hasSavingRequest requests =
    Host.pending requests
        |> List.any
            (\pending ->
                case pending of
                    FinishSave ->
                        True

                    ApplyWords ->
                        False

                    IgnoreReply ->
                        False

                    PartnerReply _ ->
                        False
            )



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | OutcomeEvent String String
    | InspirationsEvent (List String)
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Err _ ->
            ( model, Cmd.none )

        Ok (SnapshotEvent snapshot) ->
            applySnapshot snapshot model

        Ok (InspirationsEvent images) ->
            -- The same list comes with every refresh; only a changed one is taken, keeping the image shown.
            if images == model.inspirations then
                ( model, Cmd.none )

            else
                ( { model | inspirations = images }, Cmd.none )

        Ok (OutcomeEvent projectId outcome) ->
            case currentProject model of
                Just project ->
                    -- Only fill an empty field, so a late reply never overwrites restored or typed text.
                    if project.id == projectId && String.isEmpty model.desiredOutcome then
                        ( { model | desiredOutcome = outcome }, Cmd.none )

                    else
                        ( model, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests, saving = hasSavingRequest requests }
            in
            case ( outcome.result, pending ) of
                ( Err message, Just (PartnerReply generation) ) ->
                    if generation == next.partner.generation then
                        let
                            partner =
                                next.partner
                        in
                        -- Waits a while before trying again, and says why in its own panel.
                        ( { next | partner = { partner | asking = False, sinceReply = -60, problem = Just message } }, Cmd.none )

                    else
                        ( next, Cmd.none )

                ( Err message, _ ) ->
                    ( { next | error = Just message }, Cmd.none )

                ( Ok resultValue, _ ) ->
                    finish (Maybe.withDefault IgnoreReply pending)
                        resultValue
                        { next | error = Nothing }


applySnapshot : Snapshot -> Model -> ( Model, Cmd Msg )
applySnapshot snapshot model =
    let
        next =
            { model | snapshot = snapshot }
    in
    case model.session of
        Just (TopicSession _) ->
            ( next, Cmd.none )

        _ ->
            let
                stillThere =
                    currentAction model
                        |> Maybe.andThen (\action -> Data.findAction action.id (candidates snapshot))
            in
            case stillThere of
                Just action ->
                    ( { next | session = Just (TaskSession action.id) }, Cmd.none )

                Nothing ->
                    case List.head (candidates snapshot) of
                        Just action ->
                            newSession { next | session = Just (TaskSession action.id) }

                        Nothing ->
                            ( { next | session = Nothing, ideas = "", desiredOutcome = "", seconds = sessionSeconds }, Cmd.none )


finish : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finish pending resultValue model =
    case pending of
        ApplyWords ->
            case Decode.decodeValue (Decode.list Decode.string) resultValue of
                Ok words ->
                    ( { model | words = words }, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        FinishSave ->
            let
                closed =
                    { model | partner = idlePartner (model.partner.generation + 1) }
            in
            case model.session of
                Just (TopicSession _) ->
                    ( { closed | session = Nothing, topicDraft = "", ideas = "", desiredOutcome = "", seconds = sessionSeconds }, Cmd.none )

                _ ->
                    ( { closed | ideas = "" }, Cmd.none )

        PartnerReply generation ->
            if generation /= model.partner.generation then
                ( model, Cmd.none )

            else
                let
                    partner =
                        model.partner

                    decoded =
                        Decode.decodeValue
                            (Decode.map2 Tuple.pair
                                (Decode.field "ideas" (Decode.list Decode.string))
                                (Decode.field "considerations" (Decode.list Decode.string))
                            )
                            resultValue
                            |> Result.withDefault ( [], [] )

                    ( ideas, considerations ) =
                        decoded
                in
                ( { model
                    | partner =
                        { partner
                            | asking = False
                            , sinceReply = 0
                            , problem = Nothing
                            , ideas = ideas ++ partner.ideas
                            , considerations = considerations ++ partner.considerations
                            , offered = partner.offered ++ ideas ++ considerations
                        }
                  }
                , Cmd.none
                )

        IgnoreReply ->
            ( model, Cmd.none )



-- VIEW


view : Model -> Html Msg
view model =
    let
        available =
            candidates model.snapshot
    in
    div [ class "dg-view dg-brainstorm-view" ]
        [ header [ class "dg-view-header" ]
            [ div []
                [ h2 [] [ text "Brainstorm" ]
                , span [ class "dg-count" ]
                    [ text (String.fromInt (List.length available)) ]
                ]
            , case model.session of
                Just _ ->
                    span [ classList [ ( "dg-brainstorm-timer", True ), ( "is-done", model.seconds == 0 ) ] ]
                        [ text
                            (if model.seconds == 0 then
                                "✓ five minutes reached"

                             else
                                Ui.timer model.seconds
                            )
                        ]

                Nothing ->
                    text ""
            ]
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , Ui.maybeView model.setAside
            (\_ ->
                div [ class "dg-panel dg-undo-bar", attribute "role" "status" ]
                    [ span [] [ text "Your ideas from the last session were set aside." ]
                    , button [ class "mod-cta", onClick RestoreSetAside ] [ text "Undo" ]
                    , button [ class "dg-flat-button", onClick DismissSetAside ] (Ui.iconLabel "×" "Dismiss")
                    ]
            )
        , case model.session of
            Just session ->
                viewSession model session

            Nothing ->
                viewEmpty model
        ]


viewEmpty : Model -> Html Msg
viewEmpty model =
    div [ class "dg-workflow-complete dg-brainstorm-empty" ]
        [ span [] [ text "💡" ]
        , h3 [] [ text "Start a standalone brainstorm" ]
        , p [] [ text "No “brainstorm” Action is required. The result will be captured as an Inbox Item." ]
        , section [ class "dg-brainstorm-field dg-brainstorm-start-field" ]
            [ label [ for "dg-brainstorm-topic" ] [ text "Brainstorming topic" ]
            , div [ class "dg-brainstorm-start" ]
                [ input
                    [ id "dg-brainstorm-topic"
                    , autofocus True
                    , value model.topicDraft
                    , placeholder "What do you want to brainstorm?"
                    , onInput TopicChanged
                    , Ui.onEnter { enter = StartTopic, ignore = NoOp }
                    ]
                    []
                , button [ class "mod-cta", disabled (String.isEmpty (String.trim model.topicDraft)), onClick StartTopic ] [ text "Start brainstorming" ]
                ]
            ]
        ]


viewSession : Model -> Session -> Html Msg
viewSession model session =
    let
        project =
            currentProject model

        standalone =
            case session of
                TopicSession _ ->
                    True

                TaskSession _ ->
                    False

        sessionTitle =
            case session of
                TopicSession fields ->
                    fields.topic

                TaskSession _ ->
                    currentAction model |> Maybe.map .title |> Maybe.withDefault ""
    in
    div [ class "dg-brainstorm-content" ]
        [ section [ class "dg-brainstorm-task" ]
            [ div []
                [ span []
                    [ text
                        (if standalone then
                            "Standalone topic"

                         else
                            "Brainstorm this"
                        )
                    ]
                , h3 [] [ text sessionTitle ]
                , case project of
                    Just item ->
                        button [ onClick (Send IgnoreReply (Command.ShowProject item.id)) ] [ text item.title ]

                    Nothing ->
                        small []
                            [ text
                                (if standalone then
                                    "No source Action — output will return to Inbox"

                                 else
                                    "No Project — output will return to Inbox"
                                )
                            ]
                ]
            , button
                [ onClick
                    (if standalone then
                        AbandonTopic

                     else
                        ShuffleTask
                    )
                ]
                [ text
                    (if standalone then
                        "Change topic"

                     else
                        "Shuffle"
                    )
                ]
            ]
        , Ui.maybeView (currentInspiration model) inspirationView
        , section [ class "dg-word-bank" ]
            [ div [ class "dg-section-heading" ] [ h3 [] [ text "Random prompts" ], button [ onClick ShufflePrompts ] [ text "Shuffle words" ] ]
            , div [] (List.map (\word -> button [ onClick (InsertWord word) ] [ text word ]) model.words)
            ]
        , Ui.maybeView project
            (\_ ->
                section [ class "dg-brainstorm-field" ]
                    [ label [ for "dg-brainstorm-outcome" ] [ text "Desired outcome" ]
                    , textarea [ id "dg-brainstorm-outcome", value model.desiredOutcome, placeholder "What future state are you working toward?", onInput OutcomeChanged ] []
                    ]
            )
        , section [ class "dg-brainstorm-field dg-ideas-field" ]
            [ label [ for "dg-brainstorm-ideas" ] [ text "Your ideas" ]
            , textarea
                [ id "dg-brainstorm-ideas"
                , autofocus True
                , attribute "data-brainstorm-ideas" "true"
                , value model.ideas
                , placeholder "Let it flow—there are no wrong answers.\n\nTry another angle. Reverse it. Find the simplest version. Imagine unlimited resources."
                , onInput IdeasChanged
                , onSelection IdeasSelected
                ]
                []
            ]
        , if model.partnerAvailable then
            partnerView model

          else
            text ""
        , div [ class "dg-workflow-footer" ]
            [ span []
                [ text
                    (case project of
                        Just item ->
                            "Saves into " ++ item.title ++ "'s support folder"

                        Nothing ->
                            "Creates a new Inbox Item"
                    )
                ]
            , button [ class "mod-cta", disabled (String.isEmpty (String.trim model.ideas) || model.saving), onClick Save ]
                [ text
                    (if model.saving then
                        "Saving…"

                     else if standalone then
                        "Save ideas to Inbox"

                     else
                        "Save ideas and complete Action"
                    )
                ]
            ]
        ]


{-| One image from the inspiration folder, changed every three minutes. It is there
to look at, not to read, so screen readers skip it.
-}
inspirationView : String -> Html Msg
inspirationView url =
    section [ class "dg-brainstorm-inspiration" ]
        [ img [ src url, alt "", attribute "aria-hidden" "true" ] []
        , div [ class "dg-brainstorm-inspiration-bar" ]
            [ small [] [ text "Inspiration · a new one every three minutes" ]
            , button [ class "dg-flat-button", onClick NextInspiration ] [ text "Next image" ]
            ]
        ]


{-| The partner's panel: how to start it, what it is doing, and what it offers.
-}
partnerView : Model -> Html Msg
partnerView model =
    let
        partner =
            model.partner

        status =
            if partner.asking then
                "Thinking…"

            else if not partner.on then
                "Stopped."

            else if model.seconds == 0 then
                "The five minutes are up; More asks again."

            else
                "Listening: it adds more when you pause."

        suggestion item =
            li [ class "dg-partner-item" ]
                [ span [] [ text item ]
                , button [ class "dg-partner-add", onClick (AddSuggestion item) ] [ text "+ Add" ]
                , button [ class "dg-flat-button dg-partner-dismiss", onClick (DismissSuggestion item) ] (Ui.iconLabel "×" ("Dismiss " ++ item))
                ]

        list heading items =
            if List.isEmpty items then
                text ""

            else
                div [ class "dg-partner-list" ] [ h4 [] [ text heading ], ul [] (List.map suggestion items) ]
    in
    section [ class "dg-brainstorm-partner" ]
        [ div [ class "dg-section-heading" ]
            [ h3 [] [ text "Local partner" ]
            , if partner.on || partner.asking then
                div [ class "dg-partner-controls" ]
                    [ button [ disabled partner.asking, onClick AskPartner ] [ text "More" ]
                    , button [ onClick StopPartner ] [ text "Stop" ]
                    ]

              else
                button [ class "mod-cta", onClick StartPartner ] [ text "Start local partner" ]
            ]
        , if partner.on || partner.asking || not (List.isEmpty partner.offered) then
            p [ class "dg-partner-status", attribute "aria-live" "polite" ] [ text status ]

          else
            p [ class "dg-muted" ]
                [ text "The local model from the agent settings adds ideas and things to consider while you write: when you pause, and at least every 45 seconds. It sees only this brainstorm, and nothing leaves this Mac." ]
        , Ui.maybeView partner.problem (\problem -> p [ class "dg-partner-problem" ] [ text ("⚠ " ++ problem) ])
        , list "Ideas" partner.ideas
        , list "To consider" partner.considerations
        ]


onSelection : (Int -> Int -> msg) -> Html.Attribute msg
onSelection tagger =
    on "select"
        (Decode.map2 tagger
            (Decode.at [ "target", "selectionStart" ] Decode.int)
            (Decode.at [ "target", "selectionEnd" ] Decode.int)
        )



-- QUERIES


{-| The open Actions that ask to be brainstormed.
-}
candidates : Snapshot -> List Action
candidates snapshot =
    snapshot.actions
        |> List.filter (\action -> ActionStatus.isOpen action.status && String.contains "brainstorm" (String.toLower action.title))


currentAction : Model -> Maybe Action
currentAction model =
    case model.session of
        Just (TaskSession actionId) ->
            case Data.findAction actionId (candidates model.snapshot) of
                Just action ->
                    Just action

                Nothing ->
                    List.head (candidates model.snapshot)

        _ ->
            Nothing


currentProject : Model -> Maybe Project
currentProject model =
    currentAction model
        |> Maybe.andThen .projectId
        |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects)


itemAt : Int -> List a -> Maybe a
itemAt index items =
    if index < 0 then
        Nothing

    else
        List.drop index items |> List.head


indexOf : ActionId -> List Action -> Maybe Int
indexOf actionId actions =
    actions
        |> List.indexedMap Tuple.pair
        |> List.filter (\( _, action ) -> action.id == actionId)
        |> List.head
        |> Maybe.map Tuple.first



-- DECODING


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map5 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "words" (Decode.list Decode.string))
        (Decode.field "randomIndex" Decode.int)
        (Decode.oneOf [ Decode.field "partner" Decode.bool, Decode.succeed False ])
        (Decode.oneOf [ Decode.field "inspirations" (Decode.list Decode.string), Decode.succeed [] ])


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "inspirations" ->
                        Decode.map InspirationsEvent (Decode.field "urls" (Decode.list Decode.string))

                    "brainstorm-outcome" ->
                        Decode.map2 OutcomeEvent
                            (Decode.field "projectId" Decode.string)
                            (Decode.field "desiredOutcome" Decode.string)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
