port module Brainstorm exposing (main)

import Browser
import Dict exposing (Dict)
import Html exposing (Html, button, div, h2, h3, header, input, label, p, section, small, span, text, textarea)
import Html.Attributes exposing (attribute, autofocus, class, classList, disabled, placeholder, value)
import Html.Events exposing (on, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Time


port brainstormToHost : Encode.Value -> Cmd msg


port brainstormFromHost : (Decode.Value -> msg) -> Sub msg


protocolVersion : Int
protocolVersion =
    1


type alias Action =
    { id : String, title : String, status : String, projectId : Maybe String }


type alias Project =
    { id : String, title : String }


type alias Snapshot =
    { revision : Int, actions : List Action, projects : List Project }


type Pending
    = Ignore
    | ShuffleWords
    | SaveSession


type alias Model =
    { snapshot : Snapshot
    , selectedId : Maybe String
    , standaloneTopic : String
    , standalone : Bool
    , desiredOutcome : String
    , ideas : String
    , words : List String
    , seconds : Int
    , selectionStart : Int
    , selectionEnd : Int
    , nextRequest : Int
    , pending : Dict String Pending
    , saving : Bool
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | Tick Time.Posix
    | TopicChanged String
    | StartStandalone
    | ChangeTopic
    | ShuffleTask
    | ShufflePrompts
    | OutcomeChanged String
    | IdeasChanged String
    | IdeasSelected Int Int
    | InsertWord String
    | Save
    | HostCommand Pending Encode.Value
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> Sub.batch [ brainstormFromHost GotHost, Time.every 1000 Tick ]
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            let
                available =
                    candidates decoded.snapshot

                selected =
                    if List.isEmpty available then
                        Nothing

                    else
                        itemAt (modBy (List.length available) decoded.randomIndex) available |> Maybe.map .id

                model =
                    { snapshot = decoded.snapshot
                    , selectedId = selected
                    , standaloneTopic = ""
                    , standalone = False
                    , desiredOutcome = ""
                    , ideas = ""
                    , words = decoded.words
                    , seconds = 300
                    , selectionStart = 0
                    , selectionEnd = 0
                    , nextRequest = 1
                    , pending = Dict.empty
                    , saving = False
                    , error = Nothing
                    }
            in
            loadOutcome model

        Err error ->
            ( emptyModel (Decode.errorToString error), Cmd.none )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value_ ->
            receiveHost value_ model

        Tick _ ->
            if sessionActive model then
                ( { model | seconds = max 0 (model.seconds - 1) }, Cmd.none )

            else
                ( model, Cmd.none )

        TopicChanged topic ->
            ( { model | standaloneTopic = topic }, Cmd.none )

        StartStandalone ->
            if String.isEmpty (String.trim model.standaloneTopic) then
                ( model, Cmd.none )

            else
                newSession { model | standalone = True, selectedId = Nothing }

        ChangeTopic ->
            ( { model | standalone = False, standaloneTopic = "", ideas = "", desiredOutcome = "", seconds = 300 }, Cmd.none )

        ShuffleTask ->
            let
                available =
                    candidates model.snapshot

                currentIndex =
                    model.selectedId |> Maybe.andThen (\id_ -> findIndex id_ available) |> Maybe.withDefault -1

                selected =
                    itemAt (modBy (max 1 (List.length available)) (currentIndex + 1)) available |> Maybe.map .id
            in
            newSession { model | selectedId = selected, standalone = False }

        ShufflePrompts ->
            send ShuffleWords (simpleCommand "shuffle-brainstorm-words") model

        OutcomeChanged outcome ->
            ( { model | desiredOutcome = outcome }, Cmd.none )

        IdeasChanged ideas ->
            ( { model | ideas = ideas, selectionStart = String.length ideas, selectionEnd = String.length ideas }, Cmd.none )

        IdeasSelected start end ->
            ( { model | selectionStart = start, selectionEnd = end }, Cmd.none )

        InsertWord word ->
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

                next =
                    { model | ideas = before ++ insertion ++ after, selectionStart = cursor, selectionEnd = cursor }
            in
            send Ignore (focusCommand cursor) next

        Save ->
            if String.isEmpty (String.trim model.ideas) then
                ( model, Cmd.none )

            else if model.standalone then
                send SaveSession (standaloneSaveCommand model) { model | saving = True }

            else
                case currentAction model of
                    Just action ->
                        send SaveSession (actionSaveCommand model action) { model | saving = True }

                    Nothing ->
                        ( model, Cmd.none )

        HostCommand pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


type HostEvent
    = SnapshotEvent Snapshot
    | OutcomeEvent String String
    | CommandResult String Bool (Maybe String) Decode.Value


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value_ model =
    case Decode.decodeValue hostEventDecoder value_ of
        Err _ ->
            ( model, Cmd.none )

        Ok event ->
            case event of
                SnapshotEvent snapshot ->
                    let
                        next =
                            { model | snapshot = snapshot }

                        selectedStillExists =
                            model.selectedId
                                |> Maybe.andThen (\id_ -> candidates snapshot |> List.filter (\action -> action.id == id_) |> List.head)
                    in
                    if model.standalone then
                        ( next, Cmd.none )

                    else
                        case selectedStillExists of
                            Just action ->
                                ( { next | selectedId = Just action.id }, Cmd.none )

                            Nothing ->
                                case List.head (candidates snapshot) of
                                    Just action ->
                                        newSession { next | selectedId = Just action.id }

                                    Nothing ->
                                        ( { next | selectedId = Nothing, ideas = "", desiredOutcome = "", seconds = 300 }, Cmd.none )

                OutcomeEvent projectId outcome ->
                    case currentProject model of
                        Just project ->
                            if project.id == projectId then
                                ( { model | desiredOutcome = outcome }, Cmd.none )

                            else
                                ( model, Cmd.none )

                        Nothing ->
                            ( model, Cmd.none )

                CommandResult requestId ok errorMessage resultValue ->
                    let
                        pending =
                            Dict.get requestId model.pending |> Maybe.withDefault Ignore

                        next =
                            { model
                                | pending = Dict.remove requestId model.pending
                                , saving = False
                                , error =
                                    if ok then
                                        Nothing

                                    else
                                        errorMessage
                            }
                    in
                    if not ok then
                        ( next, Cmd.none )

                    else
                        finish pending resultValue next


finish : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finish pending resultValue model =
    case pending of
        ShuffleWords ->
            case Decode.decodeValue (Decode.list Decode.string) resultValue of
                Ok words ->
                    ( { model | words = words }, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        SaveSession ->
            if model.standalone then
                ( { model | standalone = False, standaloneTopic = "", ideas = "", desiredOutcome = "", seconds = 300 }, Cmd.none )

            else
                ( { model | ideas = "" }, Cmd.none )

        Ignore ->
            ( model, Cmd.none )


newSession : Model -> ( Model, Cmd Msg )
newSession model =
    let
        reset =
            { model | desiredOutcome = "", ideas = "", seconds = 300, selectionStart = 0, selectionEnd = 0, error = Nothing }

        ( shuffled, shuffleCmd ) =
            send ShuffleWords (simpleCommand "shuffle-brainstorm-words") reset

        ( loaded, outcomeCmd ) =
            loadOutcome shuffled
    in
    ( loaded, Cmd.batch [ shuffleCmd, outcomeCmd ] )


loadOutcome : Model -> ( Model, Cmd Msg )
loadOutcome model =
    case currentProject model of
        Just project ->
            send Ignore (projectCommand "load-brainstorm-outcome" project.id) model

        Nothing ->
            ( model, Cmd.none )


send : Pending -> Encode.Value -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        requestId =
            "brainstorm-" ++ String.fromInt model.nextRequest
    in
    ( { model | nextRequest = model.nextRequest + 1, pending = Dict.insert requestId pending model.pending }
    , brainstormToHost (Encode.object [ ( "protocolVersion", Encode.int protocolVersion ), ( "requestId", Encode.string requestId ), ( "command", command ) ])
    )


view : Model -> Html Msg
view model =
    let
        available =
            candidates model.snapshot
    in
    div [ class "dg-view dg-brainstorm-view" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Brainstorm" ], span [ class "dg-count" ] [ text (String.fromInt (List.length available)) ] ]
            , if sessionActive model then
                span [ classList [ ( "dg-brainstorm-timer", True ), ( "is-done", model.seconds == 0 ) ] ]
                    [ text
                        (if model.seconds == 0 then
                            "✓ five minutes reached"

                         else
                            formatTimer model.seconds
                        )
                    ]

              else
                text ""
            ]
        , maybeError model.error
        , if sessionActive model then
            viewSession model

          else
            viewEmpty model
        ]


viewEmpty : Model -> Html Msg
viewEmpty model =
    div [ class "dg-workflow-complete dg-brainstorm-empty" ]
        [ span [] [ text "💡" ]
        , h3 [] [ text "Start a standalone brainstorm" ]
        , p [] [ text "No “brainstorm” Action is required. The result will be captured as an Inbox Item." ]
        , section [ class "dg-brainstorm-field dg-brainstorm-start-field" ]
            [ label [] [ text "Brainstorming topic" ]
            , div [ class "dg-brainstorm-start" ]
                [ input [ autofocus True, value model.standaloneTopic, placeholder "What do you want to brainstorm?", onInput TopicChanged, onEnter StartStandalone ] []
                , button [ class "mod-cta", disabled (String.isEmpty (String.trim model.standaloneTopic)), onClick StartStandalone ] [ text "Start brainstorming" ]
                ]
            ]
        ]


viewSession : Model -> Html Msg
viewSession model =
    let
        action =
            currentAction model

        project =
            currentProject model

        sessionTitle =
            if model.standalone then
                model.standaloneTopic

            else
                Maybe.map .title action |> Maybe.withDefault ""
    in
    div [ class "dg-brainstorm-content" ]
        [ section [ class "dg-brainstorm-task" ]
            [ div []
                [ span []
                    [ text
                        (if model.standalone then
                            "Standalone topic"

                         else
                            "Brainstorm this"
                        )
                    ]
                , h3 [] [ text sessionTitle ]
                , case project of
                    Just item ->
                        button [ onClick (HostCommand Ignore (projectCommand "show-project" item.id)) ] [ text item.title ]

                    Nothing ->
                        small []
                            [ text
                                (if model.standalone then
                                    "No source Action — output will return to Inbox"

                                 else
                                    "No Project — output will return to Inbox"
                                )
                            ]
                ]
            , button
                [ onClick
                    (if model.standalone then
                        ChangeTopic

                     else
                        ShuffleTask
                    )
                ]
                [ text
                    (if model.standalone then
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
        , case project of
            Just _ ->
                section [ class "dg-brainstorm-field" ] [ label [] [ text "Desired outcome" ], textarea [ value model.desiredOutcome, placeholder "What future state are you working toward?", onInput OutcomeChanged ] [] ]

            Nothing ->
                text ""
        , section [ class "dg-brainstorm-field dg-ideas-field" ]
            [ label [] [ text "Your ideas" ]
            , textarea
                [ autofocus True
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

                     else if model.standalone then
                        "Save ideas to Inbox"

                     else
                        "Save ideas and complete Action"
                    )
                ]
            ]
        ]


candidates : Snapshot -> List Action
candidates snapshot =
    snapshot.actions |> List.filter (\action -> not (List.member action.status [ "done", "cancelled" ]) && String.contains "brainstorm" (String.toLower action.title))


currentAction : Model -> Maybe Action
currentAction model =
    if model.standalone then
        Nothing

    else
        model.selectedId
            |> Maybe.andThen (\id_ -> candidates model.snapshot |> List.filter (\action -> action.id == id_) |> List.head)
            |> (\selected ->
                    case selected of
                        Just _ ->
                            selected

                        Nothing ->
                            List.head (candidates model.snapshot)
               )


currentProject : Model -> Maybe Project
currentProject model =
    currentAction model
        |> Maybe.andThen .projectId
        |> Maybe.andThen (\id_ -> model.snapshot.projects |> List.filter (\project -> project.id == id_) |> List.head)


sessionActive : Model -> Bool
sessionActive model =
    model.standalone || currentAction model /= Nothing


itemAt : Int -> List a -> Maybe a
itemAt index items =
    List.drop index items |> List.head


findIndex : String -> List Action -> Maybe Int
findIndex actionId actions =
    let
        walk index remaining =
            case remaining of
                [] ->
                    Nothing

                action :: rest ->
                    if action.id == actionId then
                        Just index

                    else
                        walk (index + 1) rest
    in
    walk 0 actions


formatTimer : Int -> String
formatTimer seconds =
    String.fromInt (seconds // 60) ++ ":" ++ (String.fromInt (modBy 60 seconds) |> String.padLeft 2 '0')


maybeError : Maybe String -> Html Msg
maybeError error =
    Maybe.map (\message -> div [ class "dg-panel dg-error" ] [ text message ]) error |> Maybe.withDefault (text "")


onEnter : Msg -> Html.Attribute Msg
onEnter message =
    on "keydown"
        (Decode.map
            (\key ->
                if key == "Enter" then
                    message

                else
                    NoOp
            )
            (Decode.field "key" Decode.string)
        )


onSelection : (Int -> Int -> msg) -> Html.Attribute msg
onSelection tagger =
    let
        decoder =
            Decode.map2 tagger (Decode.at [ "target", "selectionStart" ] Decode.int) (Decode.at [ "target", "selectionEnd" ] Decode.int)
    in
    on "select" decoder


simpleCommand : String -> Encode.Value
simpleCommand kind =
    Encode.object [ ( "type", Encode.string kind ) ]


projectCommand : String -> String -> Encode.Value
projectCommand kind projectId =
    Encode.object [ ( "type", Encode.string kind ), ( "projectId", Encode.string projectId ) ]


focusCommand : Int -> Encode.Value
focusCommand cursor =
    Encode.object [ ( "type", Encode.string "focus-brainstorm-ideas" ), ( "start", Encode.int cursor ), ( "end", Encode.int cursor ) ]


standaloneSaveCommand : Model -> Encode.Value
standaloneSaveCommand model =
    Encode.object [ ( "type", Encode.string "save-standalone-brainstorm" ), ( "topic", Encode.string model.standaloneTopic ), ( "ideas", Encode.string model.ideas ) ]


actionSaveCommand : Model -> Action -> Encode.Value
actionSaveCommand model action =
    Encode.object
        ([ ( "type", Encode.string "save-brainstorm" ), ( "actionId", Encode.string action.id ), ( "ideas", Encode.string model.ideas ) ]
            ++ (case currentProject model of
                    Just _ ->
                        [ ( "desiredOutcome", Encode.string model.desiredOutcome ) ]

                    Nothing ->
                        []
               )
        )


type alias Flags =
    { snapshot : Snapshot, words : List String, randomIndex : Int }


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map3 Flags (Decode.field "snapshot" snapshotDecoder) (Decode.field "words" (Decode.list Decode.string)) (Decode.field "randomIndex" Decode.int)


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    Decode.map3 Snapshot (Decode.field "revision" Decode.int) (Decode.field "actions" (Decode.list actionDecoder)) (Decode.field "projects" (Decode.list projectDecoder))


actionDecoder : Decoder Action
actionDecoder =
    Decode.map4 Action (Decode.field "id" Decode.string) (Decode.field "title" Decode.string) (Decode.field "status" Decode.string) (optionalField "projectId" (Decode.maybe Decode.string) Nothing)


projectDecoder : Decoder Project
projectDecoder =
    Decode.map2 Project (Decode.field "id" Decode.string) (Decode.field "title" Decode.string)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" snapshotDecoder)

                    "brainstorm-outcome" ->
                        Decode.map2 OutcomeEvent (Decode.field "projectId" Decode.string) (Decode.field "desiredOutcome" Decode.string)

                    "command-result" ->
                        Decode.map4 CommandResult (Decode.field "requestId" Decode.string) (Decode.field "ok" Decode.bool) (optionalField "error" (Decode.maybe Decode.string) Nothing) (optionalField "value" Decode.value Encode.null)

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name decoder fallback =
    Decode.oneOf [ Decode.field name decoder, Decode.succeed fallback ]


emptyModel : String -> Model
emptyModel message =
    { snapshot = { revision = 0, actions = [], projects = [] }
    , selectedId = Nothing
    , standaloneTopic = ""
    , standalone = False
    , desiredOutcome = ""
    , ideas = ""
    , words = []
    , seconds = 300
    , selectionStart = 0
    , selectionEnd = 0
    , nextRequest = 1
    , pending = Dict.empty
    , saving = False
    , error = Just message
    }
