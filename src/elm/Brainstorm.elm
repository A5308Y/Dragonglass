port module Brainstorm exposing (main)

import Browser
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.Brainstorm as Command exposing (Command)
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Host as Host exposing (RequestId, Requests)
import Gtd.Id exposing (ActionId)
import Gtd.Ui as Ui
import Html exposing (Html, button, div, h2, h3, header, input, label, p, section, small, span, text, textarea)
import Html.Attributes exposing (attribute, autofocus, class, classList, disabled, for, id, placeholder, title, value)
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
    | Send Pending Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> Sub.batch [ brainstormFromHost GotHost, Time.every 1000 Tick ]
        , view = view
        }


type alias Flags =
    { snapshot : Snapshot, words : List String, randomIndex : Int }


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
            loadOutcome (emptyModel decoded.snapshot decoded.words session)

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
    }


blankModel : Model
blankModel =
    emptyModel Data.empty [] Nothing


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        Tick _ ->
            if model.session == Nothing then
                ( model, Cmd.none )

            else
                ( { model | seconds = max 0 (model.seconds - 1) }, Cmd.none )

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
            ( { model | ideas = ideas, selectionStart = String.length ideas, selectionEnd = String.length ideas }, Cmd.none )

        IdeasSelected start end ->
            ( { model | selectionStart = start, selectionEnd = end }, Cmd.none )

        InsertWord word ->
            insertWord word model

        Save ->
            save model

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
            { model | desiredOutcome = "", ideas = "", seconds = sessionSeconds, selectionStart = 0, selectionEnd = 0, error = Nothing }

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
            )



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | OutcomeEvent String String
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Err _ ->
            ( model, Cmd.none )

        Ok (SnapshotEvent snapshot) ->
            applySnapshot snapshot model

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
            case outcome.result of
                Err message ->
                    ( { next | error = Just message }, Cmd.none )

                Ok resultValue ->
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
            case model.session of
                Just (TopicSession _) ->
                    ( { model | session = Nothing, topicDraft = "", ideas = "", desiredOutcome = "", seconds = sessionSeconds }, Cmd.none )

                _ ->
                    ( { model | ideas = "" }, Cmd.none )

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
    Decode.map3 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "words" (Decode.list Decode.string))
        (Decode.field "randomIndex" Decode.int)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "brainstorm-outcome" ->
                        Decode.map2 OutcomeEvent
                            (Decode.field "projectId" Decode.string)
                            (Decode.field "desiredOutcome" Decode.string)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
